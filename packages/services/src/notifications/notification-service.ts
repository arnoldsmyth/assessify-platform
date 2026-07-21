import {
  err,
  notificationRequestSchema,
  ok,
  uuidv7,
  type DomainError,
  type JobPayload,
  type NotificationKind,
  type NotificationLogEntry,
  type NotificationStatus,
  type Result,
} from '@assessify/domain';
import type { JobQueue, Mailer, MailProviderEvent } from '@assessify/adapters';
import type { NotificationLogRepository } from '@assessify/repositories';

/**
 * Notification business logic (D4 — spec 13). The one path every email takes:
 *
 *   caller (order/reminder/billing service or controller) → send()
 *     → notification_log row (`queued`) → `notifications.send` job
 *   worker processor → deliverQueued() → Mailer adapter → `sent` / `failed`
 *   SendGrid event webhook → recordProviderEvent() → `delivered`/`opened`/`bounced`
 *
 * The service decides *when* and *what to record*; the injected Mailer only
 * knows *how* to send (appendix-architecture-layers.md §4). Sender identity
 * arrives per call (product `branding.emailFrom` or platform sender, spec 11)
 * — nothing here is assessment- or product-specific, so D5/D6/E6 can build
 * every notification kind on this API.
 *
 * PII rule: recipient addresses live in the log table and the job payload,
 * never in error messages or log lines produced here.
 */

export interface NotificationSendReceipt {
  notificationId: string;
  status: Extract<NotificationStatus, 'queued'>;
}

export interface NotificationDeliveryReceipt {
  notificationId: string;
  status: NotificationStatus;
  providerMessageId: string | null;
}

export interface ProviderEventOutcome {
  /** False when no notification_log row matches the event (not an error). */
  matched: boolean;
  /** True when the row's status advanced because of this event. */
  changed: boolean;
  notification?: {
    id: string;
    kind: NotificationKind;
    status: NotificationStatus;
    /**
     * Traceability refs from the log row, so the webhook controller can hand
     * order-affecting events on (spec 13: invitation hard bounce → order
     * `email_error` via the invitation service).
     */
    orderId: string | null;
    sessionId: string | null;
  };
}

export interface NotificationService {
  /**
   * Validate a notification request, write the `queued` notification_log row,
   * and enqueue the async send (spec 13: no emails from request handlers).
   */
  send(input: unknown): Promise<Result<NotificationSendReceipt>>;
  /**
   * Deliver a queued notification via the Mailer (worker processor only).
   * Idempotent: a row already past `queued`/`failed` is left untouched.
   * Error results carry `detail.permanent` so the processor can decide
   * between retry and the failed set.
   */
  deliverQueued(
    payload: JobPayload<'notifications.send'>
  ): Promise<Result<NotificationDeliveryReceipt>>;
  /**
   * Apply one provider delivery event (webhook) to the log. Statuses only
   * move forward (see {@link STATUS_RANK}); unknown messages are reported as
   * unmatched, never as errors, so webhook batches keep flowing.
   */
  recordProviderEvent(event: MailProviderEvent): Promise<Result<ProviderEventOutcome>>;
}

export interface NotificationServiceDeps {
  notificationLog: NotificationLogRepository;
  /** Required for deliverQueued; the webhook path never sends. */
  mailer?: Mailer;
  /** Required for send; the worker/webhook paths never enqueue. */
  queue?: JobQueue;
  generateId?: () => string;
}

/**
 * Monotonic status ordering for provider events: an event only advances a
 * row, never rewinds it (e.g. a late `delivered` after `opened` is a no-op).
 * `bounced` outranks `opened` because a hard bounce is the authoritative
 * outcome (spec 13 delivery-failure handling); `delivered` outranks `failed`
 * because the provider's word beats our local send bookkeeping.
 */
const STATUS_RANK: Record<NotificationStatus, number> = {
  queued: 0,
  sent: 1,
  failed: 2,
  delivered: 3,
  opened: 4,
  bounced: 5,
};

/** Provider event → notification_log status. Unmapped events never change status. */
const EVENT_STATUS: Partial<Record<MailProviderEvent['type'], NotificationStatus>> = {
  delivered: 'delivered',
  opened: 'opened',
  clicked: 'opened', // a click implies an open; the log has no finer state
  bounced: 'bounced',
  dropped: 'failed',
};

function repoFailure(op: string, cause: unknown): DomainError {
  return {
    code: 'notification/log_write_failed',
    message: `failed to ${op} notification_log`,
    detail: { cause: cause instanceof Error ? cause.message : String(cause) },
  };
}

export function createNotificationService(deps: NotificationServiceDeps): NotificationService {
  const { notificationLog, mailer, queue, generateId = uuidv7 } = deps;

  return {
    async send(input) {
      const parsed = notificationRequestSchema.safeParse(input);
      if (!parsed.success) {
        return err({
          code: 'notification/validation',
          message: 'notification request failed validation',
          detail: {
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        });
      }
      if (!queue) {
        return err({
          code: 'notification/queue_unavailable',
          message: 'notification service was composed without a job queue',
        });
      }

      const request = parsed.data;
      const notificationId = generateId();
      try {
        await notificationLog.insert({
          id: notificationId,
          kind: request.kind,
          recipient: request.to,
          template: request.template,
          language: request.language,
          orderId: request.refs.orderId ?? null,
          sessionId: request.refs.sessionId ?? null,
        });
      } catch (cause) {
        return err(repoFailure('insert into', cause));
      }

      try {
        await queue.enqueue(
          'notifications.send',
          { notificationId, message: request },
          { idempotencyKey: `notifications.send:${notificationId}` }
        );
      } catch (cause) {
        // The row exists but nothing will deliver it — record the failure.
        await notificationLog.updateStatus(notificationId, 'failed').catch(() => undefined);
        return err({
          code: 'notification/enqueue_failed',
          message: 'failed to enqueue the notification send job',
          detail: {
            notificationId,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        });
      }

      return ok({ notificationId, status: 'queued' });
    },

    async deliverQueued(payload) {
      if (!mailer) {
        return err({
          code: 'notification/mailer_unavailable',
          message: 'notification service was composed without a mailer',
          detail: { permanent: true },
        });
      }

      let entry: NotificationLogEntry | null;
      try {
        entry = await notificationLog.findById(payload.notificationId);
      } catch (cause) {
        return err(repoFailure('read', cause));
      }
      if (!entry) {
        return err({
          code: 'notification/not_found',
          message: 'notification_log row not found for queued send',
          detail: { notificationId: payload.notificationId, permanent: true },
        });
      }
      // Idempotent redelivery: only queued rows (or failed ones being
      // retried by the queue's backoff) are ever handed to the mailer.
      if (entry.status !== 'queued' && entry.status !== 'failed') {
        return ok({
          notificationId: entry.id,
          status: entry.status,
          providerMessageId: entry.providerMessageId,
        });
      }

      const message = payload.message;
      try {
        const sent = await mailer.send({
          to: message.to,
          from: message.sender.from,
          ...(message.sender.replyTo !== undefined && { replyTo: message.sender.replyTo }),
          subject: message.subject,
          content: { template: message.template, data: message.data },
          language: message.language,
          refs: {
            notificationId: entry.id,
            kind: message.kind,
            ...(message.refs.orderId !== undefined && { orderId: message.refs.orderId }),
            ...(message.refs.sessionId !== undefined && { sessionId: message.refs.sessionId }),
          },
        });
        const providerMessageId = sent.providerMessageId === '' ? null : sent.providerMessageId;
        const updated = await notificationLog.markSent(entry.id, providerMessageId);
        return ok({
          notificationId: entry.id,
          status: updated?.status ?? 'sent',
          providerMessageId,
        });
      } catch (cause) {
        await notificationLog.updateStatus(entry.id, 'failed').catch(() => undefined);
        const permanent =
          typeof cause === 'object' &&
          cause !== null &&
          'permanent' in cause &&
          (cause as { permanent: unknown }).permanent === true;
        return err({
          code: 'notification/send_failed',
          message: 'the mailer provider rejected the send',
          detail: {
            notificationId: entry.id,
            permanent,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        });
      }
    },

    async recordProviderEvent(event) {
      let entry: NotificationLogEntry | null = null;
      try {
        if (event.notificationId) {
          entry = await notificationLog.findById(event.notificationId);
        }
        if (!entry && event.providerMessageId) {
          entry = await notificationLog.findByProviderMessageId(event.providerMessageId);
        }
      } catch (cause) {
        return err(repoFailure('read', cause));
      }
      if (!entry) {
        return ok({ matched: false, changed: false });
      }

      const refs = { orderId: entry.orderId, sessionId: entry.sessionId };
      const nextStatus = EVENT_STATUS[event.type];
      if (!nextStatus || STATUS_RANK[nextStatus] <= STATUS_RANK[entry.status]) {
        return ok({
          matched: true,
          changed: false,
          notification: { id: entry.id, kind: entry.kind, status: entry.status, ...refs },
        });
      }

      try {
        const updated = await notificationLog.updateStatus(entry.id, nextStatus);
        return ok({
          matched: true,
          changed: updated !== null,
          notification: {
            id: entry.id,
            kind: entry.kind,
            status: updated?.status ?? entry.status,
            ...refs,
          },
        });
      } catch (cause) {
        return err(repoFailure('update', cause));
      }
    },
  };
}
