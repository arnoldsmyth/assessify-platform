import { z } from 'zod';

import {
  brandingConfigSchema,
  err,
  generateRespondentPin,
  isSuperAdmin,
  ok,
  systemCallerContext,
  type CallerContext,
  type DomainError,
  type EmailSender,
  type JobPayload,
  type Order,
  type Product,
  type Result,
} from '@assessify/domain';
import type { JobQueue } from '@assessify/adapters';
import type {
  CustomDomainRepository,
  InvitationSessionRecord,
  InvitationSessionRepository,
  OrderRepository,
  ProductRepository,
} from '@assessify/repositories';

import type { AuditService } from '../audit';
import type { NotificationService } from '../notifications';
import type { OrderService } from '../orders';
import type { PinHasher } from '../respondent-access';
import { buildRespondentEntryUrl, resolveInvitationHost } from './invitation-link';

/**
 * Invitation dispatch + resend + email_error flow (D5 — specs 05/06/13).
 *
 * The one place respondent PINs are BORN: dispatch generates a 6-digit PIN
 * per session, hashes it with the SAME bcrypt port C1's verifier uses
 * (`PinHasher` — at-rest format can never drift from verification), stores
 * only the hash, and hands the plaintext to the notification service inside
 * the invitation email payload. The plaintext exists nowhere else — never in
 * audit detail, error detail, or any log line (spec 05 hard rule).
 *
 * Split across two trust boundaries:
 *  - `requestDispatch`/`requestResend` run in the web request with the real
 *    caller: authorize (spec 05 matrix), validate order state, enqueue the
 *    `invitations.dispatch` job. Bulk bcrypt work never runs in a request.
 *  - `dispatch` runs in the worker as system: does the PIN/email work per
 *    session and drives the order machine via `orderService.transition`
 *    (`invitations_sent` / `invitation_failed`) — never writing
 *    `orders.status` directly (D1 owns the table).
 *  - `recordInvitationBounce` is called by the SendGrid webhook controller
 *    when a hard bounce lands on an `invitation` notification: order →
 *    `email_error` + super-admin alert (spec 13: a bad address is an
 *    order-blocking problem). Idempotent under webhook redelivery.
 *
 * Assessment-agnostic: product identity (name, sender, host) is resolved per
 * order from product config; nothing here knows any particular assessment.
 */

// ---------------------------------------------------------------------------
// Boundary schemas
// ---------------------------------------------------------------------------

export const requestInvitationDispatchSchema = z.object({ orderId: z.string().uuid() }).strict();

export const requestInvitationResendSchema = z
  .object({
    orderId: z.string().uuid(),
    /** Omit to resend every invited (not yet completed) session on the order. */
    sessionId: z.string().uuid().optional(),
  })
  .strict();

export const invitationBounceSchema = z
  .object({
    orderId: z.string().uuid(),
    notificationId: z.string().uuid(),
    sessionId: z.string().uuid().nullable().default(null),
  })
  .strict();

export type RequestInvitationDispatchInput = z.input<typeof requestInvitationDispatchSchema>;
export type RequestInvitationResendInput = z.input<typeof requestInvitationResendSchema>;
export type InvitationBounceInput = z.input<typeof invitationBounceSchema>;

/** Template keys resolved by the mailer provider (spec 13). */
export const INVITATION_TEMPLATE = 'invitation';
export const ERROR_ALERT_TEMPLATE = 'error-alert';

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface InvitationJobReceipt {
  jobId: string;
}

export interface InvitationDispatchSummary {
  orderId: string;
  mode: 'dispatch' | 'resend';
  /** Invitation emails queued this run. */
  sent: number;
  /** Sessions marked invited without email (order `suppress_notifications`). */
  suppressed: number;
  /** Sessions ignored because they were already past the eligible status. */
  skipped: number;
  /** Sessions that could not be invited/resent (ids only — never PII). */
  failed: { sessionId: string; code: string }[];
  /** Order transition applied this run, if any. */
  orderTransition: 'invitations_sent' | 'invitation_failed' | null;
}

export interface InvitationBounceOutcome {
  orderId: string;
  /** False when the order was already in email_error (or otherwise moved on). */
  transitioned: boolean;
}

export interface InvitationService {
  /**
   * Admin/client action: queue invitation dispatch for an `approved` order.
   * Deduplicates while a dispatch job for the order is already queued.
   */
  requestDispatch(
    caller: CallerContext,
    input: unknown
  ): Promise<Result<InvitationJobReceipt>>;
  /**
   * Admin/client action: queue an invitation resend for one session (or all
   * invited sessions) — same token, regenerated PIN (spec 05).
   */
  requestResend(caller: CallerContext, input: unknown): Promise<Result<InvitationJobReceipt>>;
  /** Worker entry point for the `invitations.dispatch` job. */
  dispatch(
    payload: JobPayload<'invitations.dispatch'>
  ): Promise<Result<InvitationDispatchSummary>>;
  /**
   * Hard bounce on an invitation notification (SendGrid webhook path):
   * order → `email_error` via the order service + super-admin alert.
   * Idempotent — replays and already-errored orders report `transitioned:
   * false` instead of failing the webhook batch.
   */
  recordInvitationBounce(input: unknown): Promise<Result<InvitationBounceOutcome>>;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface InvitationConfig {
  /** Primary base domain for `{slug}.` product hosts (e.g. `assessify.ie`). */
  slugBaseDomain: string;
  /** Fallback sender + alert sender (spec 13: platform sender for admin mail). */
  platformSender: EmailSender;
  /** Super-admin addresses for `error_alert` mail. Empty = alerts skipped. */
  alertRecipients?: string[];
}

export interface InvitationServiceDeps {
  sessions: InvitationSessionRepository;
  orders: Pick<OrderRepository, 'findById'>;
  orderService: Pick<OrderService, 'transition'>;
  products: Pick<ProductRepository, 'findById'>;
  customDomains: Pick<CustomDomainRepository, 'findActiveByProductId'>;
  notifications: Pick<NotificationService, 'send'>;
  pinHasher: PinHasher;
  audit: AuditService;
  /** Required for requestDispatch/requestResend; the worker path never enqueues. */
  queue?: JobQueue;
  config: InvitationConfig;
  generatePin?: () => string;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Errors — ids and codes only, never respondent data or PINs.
// ---------------------------------------------------------------------------

function validationError(
  issues: ReadonlyArray<{ path: (string | number)[]; message: string }>
): DomainError {
  return {
    code: 'invitation/validation',
    message: 'Invitation payload failed validation',
    detail: {
      issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
  };
}

function orderNotFound(orderId: string): DomainError {
  return { code: 'invitation/order_not_found', message: 'Order not found', detail: { orderId, permanent: true } };
}

function orderNotDispatchable(orderId: string, status: string): DomainError {
  return {
    code: 'invitation/order_not_dispatchable',
    message: `Invitations can only be dispatched while the order is "approved" (it is "${status}")`,
    detail: { orderId, status, requiredStatus: 'approved' },
  };
}

function orderNotResendable(orderId: string, status: string): DomainError {
  return {
    code: 'invitation/order_not_resendable',
    message: `Invitations can only be resent after dispatch (order is "${status}")`,
    detail: { orderId, status, allowedStatuses: RESENDABLE_ORDER_STATUSES },
  };
}

function sessionNotResendable(sessionId: string, status: string): DomainError {
  return {
    code: 'invitation/session_not_resendable',
    message: `Only invited or started sessions can receive a resent invitation (it is "${status}")`,
    detail: { sessionId, status },
  };
}

function notificationsSuppressed(orderId: string): DomainError {
  return {
    code: 'invitation/notifications_suppressed',
    message: 'This order suppresses platform notifications (silent mode) — the ordering partner delivers invitations',
    detail: { orderId, permanent: true },
  };
}

function queueUnavailable(): DomainError {
  return {
    code: 'invitation/queue_unavailable',
    message: 'The invitation service was composed without a job queue',
  };
}

function enqueueFailed(cause: unknown): DomainError {
  return {
    code: 'invitation/enqueue_failed',
    message: 'Failed to enqueue the invitation job',
    detail: { cause: cause instanceof Error ? cause.message : String(cause) },
  };
}

function repoFailure(op: string, cause: unknown): DomainError {
  return {
    code: 'invitation/storage_failed',
    message: `Failed to ${op}`,
    detail: { cause: cause instanceof Error ? cause.message : String(cause) },
  };
}

// ---------------------------------------------------------------------------
// Authorization (spec 05: super_admin; client_admin / client_user scoped to
// the order's client — mirrors "Trigger/suppress reminders" + resend rules)
// ---------------------------------------------------------------------------

function canManageInvitations(caller: CallerContext, order: Order): boolean {
  if (caller.kind === 'system') return true;
  if (caller.kind !== 'user') return false; // api_key lands with I1
  if (isSuperAdmin(caller)) return true;
  return caller.roles.some(
    (a) =>
      a.clientId === order.clientId &&
      (a.role === 'client_admin' || (a.role === 'client_user' && a.permissions.canPlaceOrders))
  );
}

const RESENDABLE_ORDER_STATUSES = ['approved', 'sent', 'email_error'] as const;
const RESENDABLE_SESSION_STATUSES = ['invited', 'started'] as const;

function isResendableSession(session: InvitationSessionRecord): boolean {
  return (RESENDABLE_SESSION_STATUSES as readonly string[]).includes(session.status);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const SYSTEM_CALLER = systemCallerContext();

export function createInvitationService(deps: InvitationServiceDeps): InvitationService {
  const {
    sessions,
    orders,
    orderService,
    products,
    customDomains,
    notifications,
    pinHasher,
    audit,
    queue,
    config,
  } = deps;
  const generatePin = deps.generatePin ?? generateRespondentPin;
  const now = deps.now ?? (() => new Date());

  /** Product sender identity (spec 13): branding.emailFrom, else platform. */
  function senderFor(product: Product): EmailSender {
    const branding = brandingConfigSchema.safeParse(product.branding ?? {});
    return branding.success && branding.data.emailFrom
      ? branding.data.emailFrom
      : config.platformSender;
  }

  async function entryHostFor(order: Order, product: Product): Promise<string> {
    const domains = await customDomains.findActiveByProductId(order.productId);
    return resolveInvitationHost({
      productSlug: product.slug,
      slugBaseDomain: config.slugBaseDomain,
      customDomains: domains,
      clientId: order.clientId,
    });
  }

  /**
   * error_alert mail to super admins (spec 06 error states). Best-effort:
   * alert failures must never fail the flow that raised them — the audit
   * trail records how many alerts were queued.
   */
  async function sendErrorAlerts(order: Order, reason: string): Promise<number> {
    const recipients = config.alertRecipients ?? [];
    let queued = 0;
    for (const to of recipients) {
      const sent = await notifications.send({
        kind: 'error_alert',
        to,
        subject: `Order ${order.reference} entered email_error`,
        template: ERROR_ALERT_TEMPLATE,
        data: { orderId: order.id, orderReference: order.reference, reason },
        language: 'en',
        sender: { from: config.platformSender },
        refs: { orderId: order.id },
      });
      if (sent.ok) queued += 1;
    }
    return queued;
  }

  /** One invitation email through the notification service (spec 13). */
  async function sendInvitation(input: {
    order: Order;
    product: Product;
    sender: EmailSender;
    host: string;
    session: InvitationSessionRecord;
    email: string;
    pin: string;
  }): Promise<Result<{ notificationId: string }>> {
    const { order, product, sender, host, session, email, pin } = input;
    const result = await notifications.send({
      kind: 'invitation',
      to: email,
      subject: `Your ${product.name} invitation`,
      template: INVITATION_TEMPLATE,
      data: {
        // The ONLY place the plaintext PIN travels (spec 05): the email
        // payload. notification_log stores no template data.
        pin,
        entryUrl: buildRespondentEntryUrl(host, session.token),
        productName: product.name,
        firstName: session.respondent?.firstName ?? null,
      },
      language: session.language ?? order.reportLanguage,
      sender: { from: sender },
      refs: { orderId: order.id, sessionId: session.id },
    });
    if (!result.ok) return err(result.error);
    return ok({ notificationId: result.value.notificationId });
  }

  /**
   * Apply an order transition as system, tolerating `order/illegal_transition`
   * (a replayed job or concurrent run already moved the order — same pattern
   * as D3's webhook handling).
   */
  async function transitionTolerant(
    orderId: string,
    event: 'invitations_sent' | 'invitation_failed',
    extras: { reason?: string; errorDetail?: Record<string, unknown> }
  ): Promise<Result<boolean>> {
    const result = await orderService.transition(SYSTEM_CALLER, orderId, { event, ...extras });
    if (result.ok) return ok(true);
    if (result.error.code === 'order/illegal_transition') return ok(false);
    return err(result.error);
  }

  async function dispatchRun(
    order: Order,
    payload: JobPayload<'invitations.dispatch'>
  ): Promise<Result<InvitationDispatchSummary>> {
    const summary: InvitationDispatchSummary = {
      orderId: order.id,
      mode: 'dispatch',
      sent: 0,
      suppressed: 0,
      skipped: 0,
      failed: [],
      orderTransition: null,
    };
    // Replays after the order moved past dispatch (cancelled, error, hold…)
    // are a no-op — the admin drives recovery through the state machine.
    if (order.status !== 'approved' && order.status !== 'sent') return ok(summary);

    const product = await products.findById(order.productId);
    if (!product) {
      return err({
        code: 'invitation/product_not_found',
        message: 'The order references an unknown product',
        detail: { orderId: order.id, productId: order.productId, permanent: true },
      });
    }
    const sender = senderFor(product);
    const host = await entryHostFor(order, product);

    let all: InvitationSessionRecord[];
    try {
      all = await sessions.listByOrder(order.id);
    } catch (cause) {
      return err(repoFailure('read respondent sessions', cause));
    }
    const targeted = payload.sessionIds
      ? all.filter((session) => payload.sessionIds?.includes(session.id))
      : all;
    const pending = targeted.filter((session) => session.status === 'created');
    const alreadyInvited = all.some((session) => session.status !== 'created');
    summary.skipped = targeted.length - pending.length;

    for (const session of pending) {
      if (order.suppressNotifications) {
        // Silent mode (spec 06 partner API): the order still progresses, but
        // no email means no PIN to deliver — none is generated. How partners
        // receive access credentials is defined by the partner API epic (I1).
        const marked = await sessions.markInvited(session.id, null, now());
        if (marked) summary.suppressed += 1;
        else summary.skipped += 1;
        continue;
      }
      const email = session.respondent?.email;
      if (!email) {
        summary.failed.push({ sessionId: session.id, code: 'missing_email' });
        continue;
      }
      const pin = generatePin();
      const pinHash = await pinHasher.hash(pin);
      // Hash BEFORE send: the stored hash and the emailed PIN must be the
      // same generation. The status guard makes concurrent runs skip.
      let marked: boolean;
      try {
        marked = await sessions.markInvited(session.id, pinHash, now());
      } catch (cause) {
        return err(repoFailure('mark session invited', cause));
      }
      if (!marked) {
        summary.skipped += 1;
        continue;
      }
      const sent = await sendInvitation({ order, product, sender, host, session, email, pin });
      if (!sent.ok) {
        // Session is marked invited but the email never queued — surfaced in
        // the summary/audit; the per-session resend action recovers it.
        summary.failed.push({ sessionId: session.id, code: sent.error.code });
        continue;
      }
      summary.sent += 1;
    }

    // Order machine (spec 06): `sent` when ≥1 invite sent; `email_error`
    // when dispatch produced nothing at all.
    const succeeded = summary.sent + summary.suppressed > 0 || alreadyInvited;
    if (order.status === 'approved') {
      if (succeeded) {
        const applied = await transitionTolerant(order.id, 'invitations_sent', {
          reason: 'invitation_dispatch',
        });
        if (!applied.ok) return err(applied.error);
        if (applied.value) summary.orderTransition = 'invitations_sent';
      } else {
        const applied = await transitionTolerant(order.id, 'invitation_failed', {
          errorDetail: {
            reason: all.length === 0 ? 'no_sessions' : 'invitation_dispatch_failed',
            failedSessionIds: summary.failed.map((failure) => failure.sessionId),
          },
        });
        if (!applied.ok) return err(applied.error);
        if (applied.value) summary.orderTransition = 'invitation_failed';
        await sendErrorAlerts(order, 'invitation_dispatch_failed');
      }
    }

    const audited = await audit.record(
      { kind: 'system', id: 'system' },
      'invitation.dispatch_completed',
      { type: 'order', id: order.id },
      {
        mode: summary.mode,
        sent: summary.sent,
        suppressed: summary.suppressed,
        skipped: summary.skipped,
        failed: summary.failed.length,
        // Session ids only — respondent identity never enters the audit log.
        failedSessionIds: summary.failed.map((failure) => failure.sessionId),
        orderTransition: summary.orderTransition,
        requestedByUserId: payload.requestedByUserId,
      }
    );
    if (!audited.ok) return err(audited.error);
    return ok(summary);
  }

  async function resendRun(
    order: Order,
    payload: JobPayload<'invitations.dispatch'>
  ): Promise<Result<InvitationDispatchSummary>> {
    const summary: InvitationDispatchSummary = {
      orderId: order.id,
      mode: 'resend',
      sent: 0,
      suppressed: 0,
      skipped: 0,
      failed: [],
      orderTransition: null,
    };
    if (!(RESENDABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) {
      return ok(summary);
    }
    if (order.suppressNotifications) return err(notificationsSuppressed(order.id));

    const product = await products.findById(order.productId);
    if (!product) {
      return err({
        code: 'invitation/product_not_found',
        message: 'The order references an unknown product',
        detail: { orderId: order.id, productId: order.productId, permanent: true },
      });
    }
    const sender = senderFor(product);
    const host = await entryHostFor(order, product);

    let all: InvitationSessionRecord[];
    try {
      all = await sessions.listByOrder(order.id);
    } catch (cause) {
      return err(repoFailure('read respondent sessions', cause));
    }
    const targets = payload.sessionIds
      ? all.filter((session) => payload.sessionIds?.includes(session.id))
      : all.filter(isResendableSession);

    const resentSessionIds: string[] = [];
    for (const session of targets) {
      if (!isResendableSession(session)) {
        summary.skipped += 1;
        continue;
      }
      const email = session.respondent?.email;
      if (!email) {
        summary.failed.push({ sessionId: session.id, code: 'missing_email' });
        continue;
      }
      // Spec 05 resend semantics: same token, regenerated PIN — the old PIN
      // stops working the moment the new hash lands.
      const pin = generatePin();
      const pinHash = await pinHasher.hash(pin);
      let replaced: boolean;
      try {
        replaced = await sessions.replacePinHash(session.id, pinHash, now());
      } catch (cause) {
        return err(repoFailure('replace session PIN hash', cause));
      }
      if (!replaced) {
        summary.skipped += 1;
        continue;
      }
      const sent = await sendInvitation({ order, product, sender, host, session, email, pin });
      if (!sent.ok) {
        summary.failed.push({ sessionId: session.id, code: sent.error.code });
        continue;
      }
      summary.sent += 1;
      resentSessionIds.push(session.id);
    }

    // Spec 05: resends are logged to audit_log (+ notification_log via send).
    const audited = await audit.record(
      { kind: 'system', id: 'system' },
      'invitation.resent',
      { type: 'order', id: order.id },
      {
        sessionIds: resentSessionIds,
        skipped: summary.skipped,
        failed: summary.failed.length,
        failedSessionIds: summary.failed.map((failure) => failure.sessionId),
        requestedByUserId: payload.requestedByUserId,
      }
    );
    if (!audited.ok) return err(audited.error);
    return ok(summary);
  }

  return {
    async requestDispatch(caller, input) {
      const parsed = requestInvitationDispatchSchema.safeParse(input);
      if (!parsed.success) return err(validationError(parsed.error.issues));
      const { orderId } = parsed.data;
      if (!queue) return err(queueUnavailable());

      const order = await orders.findById(orderId);
      // Hide existence from out-of-scope callers (spec 05).
      if (!order || !canManageInvitations(caller, order)) return err(orderNotFound(orderId));
      if (order.status !== 'approved') return err(orderNotDispatchable(orderId, order.status));

      let jobId: string;
      try {
        const job = await queue.enqueue(
          'invitations.dispatch',
          { orderId, resend: false, requestedByUserId: caller.kind === 'user' ? caller.id : null },
          { idempotencyKey: `invitations.dispatch:${orderId}` }
        );
        jobId = job.jobId;
      } catch (cause) {
        return err(enqueueFailed(cause));
      }

      const audited = await audit.record(
        { kind: caller.kind, id: caller.id },
        'invitation.dispatch_requested',
        { type: 'order', id: orderId },
        { jobId }
      );
      if (!audited.ok) return err(audited.error);
      return ok({ jobId });
    },

    async requestResend(caller, input) {
      const parsed = requestInvitationResendSchema.safeParse(input);
      if (!parsed.success) return err(validationError(parsed.error.issues));
      const { orderId, sessionId } = parsed.data;
      if (!queue) return err(queueUnavailable());

      const order = await orders.findById(orderId);
      if (!order || !canManageInvitations(caller, order)) return err(orderNotFound(orderId));
      if (!(RESENDABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) {
        return err(orderNotResendable(orderId, order.status));
      }
      if (order.suppressNotifications) return err(notificationsSuppressed(orderId));

      if (sessionId !== undefined) {
        let all: InvitationSessionRecord[];
        try {
          all = await sessions.listByOrder(orderId);
        } catch (cause) {
          return err(repoFailure('read respondent sessions', cause));
        }
        const session = all.find((candidate) => candidate.id === sessionId);
        if (!session) {
          return err({
            code: 'invitation/session_not_found',
            message: 'Session not found on this order',
            detail: { orderId, sessionId },
          });
        }
        if (!isResendableSession(session)) {
          return err(sessionNotResendable(sessionId, session.status));
        }
      }

      let jobId: string;
      try {
        const job = await queue.enqueue(
          'invitations.dispatch',
          {
            orderId,
            ...(sessionId !== undefined && { sessionIds: [sessionId] }),
            resend: true,
            requestedByUserId: caller.kind === 'user' ? caller.id : null,
          },
          { idempotencyKey: `invitations.resend:${orderId}:${sessionId ?? 'all'}` }
        );
        jobId = job.jobId;
      } catch (cause) {
        return err(enqueueFailed(cause));
      }

      const audited = await audit.record(
        { kind: caller.kind, id: caller.id },
        'invitation.resend_requested',
        { type: 'order', id: orderId },
        { jobId, ...(sessionId !== undefined && { sessionId }) }
      );
      if (!audited.ok) return err(audited.error);
      return ok({ jobId });
    },

    async dispatch(payload) {
      let order: Order | null;
      try {
        order = await orders.findById(payload.orderId);
      } catch (cause) {
        return err(repoFailure('read order', cause));
      }
      if (!order) return err(orderNotFound(payload.orderId));
      return payload.resend ? resendRun(order, payload) : dispatchRun(order, payload);
    },

    async recordInvitationBounce(input) {
      const parsed = invitationBounceSchema.safeParse(input);
      if (!parsed.success) return err(validationError(parsed.error.issues));
      const { orderId, notificationId, sessionId } = parsed.data;

      let order: Order | null;
      try {
        order = await orders.findById(orderId);
      } catch (cause) {
        return err(repoFailure('read order', cause));
      }
      // A bounce for an unknown order (foreign environment, purged data) is
      // acknowledged, not retried forever by the provider.
      if (!order) return ok({ orderId, transitioned: false });

      const applied = await transitionTolerant(orderId, 'invitation_failed', {
        errorDetail: {
          reason: 'invitation_hard_bounce',
          notificationId,
          ...(sessionId !== null && { sessionId }),
        },
      });
      if (!applied.ok) return err(applied.error);
      if (!applied.value) return ok({ orderId, transitioned: false });

      const alertsQueued = await sendErrorAlerts(order, 'invitation_hard_bounce');
      const audited = await audit.record(
        { kind: 'system', id: 'system' },
        'invitation.bounced',
        { type: 'order', id: orderId },
        {
          notificationId,
          ...(sessionId !== null && { sessionId }),
          alertsQueued,
        }
      );
      if (!audited.ok) return err(audited.error);
      return ok({ orderId, transitioned: true });
    },
  };
}
