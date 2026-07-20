/**
 * `notifications.send` processor — the worker half of spec 13's "every send
 * goes through the worker": the service already wrote the `queued`
 * notification_log row; this hands the payload back to the service, which
 * calls the Mailer adapter and records the outcome.
 *
 * Processors stay thin (03-architecture.md): call the service, map its
 * Result. Error mapping:
 * - service unavailable / row missing / provider says permanent →
 *   `UnrecoverableError` (retrying can never succeed, park in the failed set);
 * - anything else → normal throw, retried per the queue's default backoff
 *   (spec 13: soft failures retry via BullMQ backoff before surfacing).
 *
 * Log/error strings carry ids and error codes only — never the recipient.
 */
import { UnrecoverableError } from 'bullmq';
import type { JobPayload } from '@assessify/domain';
import type { NotificationService } from '@assessify/services';

export interface NotificationsDeps {
  /** Undefined when the worker booted without DATABASE_URL (dev without a DB). */
  service: Pick<NotificationService, 'deliverQueued'> | undefined;
}

export function createNotificationSendProcessor(deps: NotificationsDeps) {
  return async (payload: JobPayload<'notifications.send'>): Promise<void> => {
    if (!deps.service) {
      throw new UnrecoverableError(
        'notifications.send: notification service not configured (set DATABASE_URL)'
      );
    }
    const result = await deps.service.deliverQueued(payload);
    if (!result.ok) {
      const permanent =
        result.error.code === 'notification/not_found' ||
        result.error.code === 'notification/mailer_unavailable' ||
        result.error.detail?.['permanent'] === true;
      const message = `notifications.send ${payload.notificationId}: ${result.error.code}`;
      if (permanent) throw new UnrecoverableError(message);
      throw new Error(message);
    }
    console.log(
      `[worker] notifications.send delivered ${payload.notificationId} (status=${result.value.status})`
    );
  };
}
