import { z } from 'zod';

import {
  brandingConfigSchema,
  err,
  isSuperAdmin,
  ok,
  type CallerContext,
  type DomainError,
  type EmailSender,
  type Product,
  type Result,
} from '@assessify/domain';
import type {
  CustomDomainRepository,
  ProductRepository,
  ReminderSessionRecord,
  ReminderSessionRepository,
} from '@assessify/repositories';

import type { AuditService } from '../audit';
import { buildRespondentEntryUrl, resolveInvitationHost } from '../invitations/invitation-link';
import type { NotificationService } from '../notifications';

/**
 * Reminder engine (D6 — spec 13): 2-day cycle, 30-day stop, manual
 * send/suppress.
 *
 * Three entry points across two trust boundaries:
 *  - `sweep()` runs in the worker (repeatable `reminders.sweep` job, hourly):
 *    selects due sessions via the repository's parameterised query, re-checks
 *    each candidate with the same pure predicate (defense in depth), stamps
 *    `reminder_count`/`last_reminder_at` with a compare-and-set BEFORE the
 *    email is queued — concurrent sweeps lose the CAS and skip, so a session
 *    can never be double-reminded — then sends through the notification
 *    service (`reminder` kind → notification_log per send).
 *  - `sendManual(caller, …)` is the admin "remind now" action (spec 05:
 *    super_admin + client_admin + scoped client_user): bypasses the 2-day
 *    spacing, the 30-day stop and the count cap (a deliberate human action),
 *    but NOT suppression, session completion, or the order's state. Audited.
 *  - `setSuppressed(caller, …)` flips the per-session opt-out. Audited.
 *
 * Reminder emails re-send the `/a/{token}` entry link only — NEVER a PIN
 * (the PIN travelled once, in the invitation; spec 05/13). No PII in audit
 * detail, errors, or log lines: session/order ids and counts only.
 *
 * Send window (spec 13): 08:00–18:00 recipient-local, falling back to the
 * product timezone. Respondent timezones are not modelled, so the product's
 * `timezone` is the operative window for every session (documented
 * simplification); sessions outside it are deferred to a later hourly run,
 * untouched.
 */

// ---------------------------------------------------------------------------
// Policy constants (spec 13 "Reminder engine")
// ---------------------------------------------------------------------------

export const REMINDER_MIN_GAP_DAYS = 2;
export const REMINDER_STOP_AFTER_DAYS = 30;
export const REMINDER_MAX_COUNT = 15;
export const REMINDER_TEMPLATE = 'reminder';
/** Spec 13 send window, hours in the product's timezone: [from, to). */
export const REMINDER_SEND_WINDOW = { fromHour: 8, toHour: 18 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Boundary schemas
// ---------------------------------------------------------------------------

export const sendManualReminderSchema = z.object({ sessionId: z.string().uuid() }).strict();

export const setReminderSuppressionSchema = z
  .object({ sessionId: z.string().uuid(), suppressed: z.boolean() })
  .strict();

export type SendManualReminderInput = z.input<typeof sendManualReminderSchema>;
export type SetReminderSuppressionInput = z.input<typeof setReminderSuppressionSchema>;

// ---------------------------------------------------------------------------
// Eligibility predicate — pure, exported for exhaustive unit testing. The
// repository's SQL mirrors exactly these rules; the sweep re-applies them to
// every candidate so a drifted query can only under-send, never over-send.
// ---------------------------------------------------------------------------

export type ReminderBlockCode =
  | 'session_status'
  | 'order_status'
  | 'order_type'
  | 'suppressed'
  | 'notifications_suppressed'
  | 'missing_email'
  | 'count_cap'
  | 'window_expired'
  | 'not_due';

/** Blocks a MANUAL send too (sweep blocks = all codes). */
const MANUAL_BLOCKS: ReadonlySet<ReminderBlockCode> = new Set([
  'session_status',
  'order_status',
  'suppressed',
  'notifications_suppressed',
  'missing_email',
]);

/** The invitation anchor: `invited_at`, else self-registration (`created_at`). */
export function reminderAnchor(record: ReminderSessionRecord): Date {
  return record.invitedAt ?? record.createdAt;
}

/**
 * Why this session must NOT receive an automatic reminder right now, or null
 * when it is due (spec 13). Boundary semantics: exactly 2 days since the last
 * touch IS due; exactly 30 days since the anchor is still inside the window.
 */
export function reminderBlock(record: ReminderSessionRecord, now: Date): ReminderBlockCode | null {
  if (record.status !== 'invited' && record.status !== 'started') return 'session_status';
  if (record.order.status !== 'sent') return 'order_status';
  if (record.order.type === 'batch_code') return 'order_type';
  if (record.order.suppressNotifications) return 'notifications_suppressed';
  if (record.remindersSuppressed) return 'suppressed';
  if (!record.respondent?.email) return 'missing_email';
  if (record.reminderCount >= REMINDER_MAX_COUNT) return 'count_cap';
  const anchor = reminderAnchor(record).getTime();
  if (now.getTime() - anchor > REMINDER_STOP_AFTER_DAYS * DAY_MS) return 'window_expired';
  const lastTouch = record.lastReminderAt?.getTime() ?? anchor;
  if (now.getTime() - lastTouch < REMINDER_MIN_GAP_DAYS * DAY_MS) return 'not_due';
  return null;
}

/**
 * Blocks that also stop a manual "remind now" (spec 13: send-now ignores the
 * 2-day spacing — and, being a deliberate human action, the 30-day stop and
 * count cap — but never suppression, completion, or a wrong order state).
 */
export function manualReminderBlock(
  record: ReminderSessionRecord,
  now: Date
): ReminderBlockCode | null {
  const block = reminderBlock(record, now);
  return block !== null && MANUAL_BLOCKS.has(block) ? block : null;
}

/**
 * Is `at` inside the send window in `timezone`? Invalid/unknown timezone
 * falls back to UTC rather than blocking reminders forever.
 */
export function isWithinSendWindow(
  at: Date,
  timezone: string,
  window: { fromHour: number; toHour: number } = REMINDER_SEND_WINDOW
): boolean {
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric',
        hourCycle: 'h23',
        timeZone: timezone,
      }).format(at)
    );
  } catch {
    hour = at.getUTCHours();
  }
  return hour >= window.fromHour && hour < window.toHour;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ReminderSweepSummary {
  /** Reminder emails queued this run. */
  sent: number;
  /** Candidates dropped by the predicate re-check or a lost CAS (concurrency). */
  skipped: number;
  /** Candidates outside their product's send window — retried next hourly run. */
  deferred: number;
  /** Stamped sessions whose email failed to queue (ids only — never PII). */
  failed: { sessionId: string; code: string }[];
}

export interface ManualReminderReceipt {
  sessionId: string;
  notificationId: string;
  /** The session's reminder count after this send. */
  reminderCount: number;
}

export interface ReminderSuppressionReceipt {
  sessionId: string;
  suppressed: boolean;
}

export interface ReminderService {
  /** Worker entry point for the repeatable `reminders.sweep` job. */
  sweep(): Promise<Result<ReminderSweepSummary>>;
  /** Admin "remind now" for one session — bypasses spacing, not suppression. */
  sendManual(caller: CallerContext, input: unknown): Promise<Result<ManualReminderReceipt>>;
  /** Suppress or resume automatic reminders for one session. */
  setSuppressed(
    caller: CallerContext,
    input: unknown
  ): Promise<Result<ReminderSuppressionReceipt>>;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ReminderConfig {
  /** Primary base domain for `{slug}.` product hosts (e.g. `assessify.ie`). */
  slugBaseDomain: string;
  /** Fallback sender for products without `branding.emailFrom` (spec 13). */
  platformSender: EmailSender;
  /** Sessions fetched per sweep batch (default 200). */
  sweepBatchSize?: number;
  /** Override of the spec 13 send window (tests / ops). */
  sendWindow?: { fromHour: number; toHour: number };
}

export interface ReminderServiceDeps {
  sessions: ReminderSessionRepository;
  products: Pick<ProductRepository, 'findById'>;
  customDomains: Pick<CustomDomainRepository, 'findActiveByProductId'>;
  notifications: Pick<NotificationService, 'send'>;
  audit: AuditService;
  config: ReminderConfig;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Errors — ids and codes only, never respondent data.
// ---------------------------------------------------------------------------

function validationError(
  issues: ReadonlyArray<{ path: (string | number)[]; message: string }>
): DomainError {
  return {
    code: 'reminder/validation',
    message: 'Reminder payload failed validation',
    detail: {
      issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
  };
}

function sessionNotFound(sessionId: string): DomainError {
  return {
    code: 'reminder/session_not_found',
    message: 'Session not found',
    detail: { sessionId, permanent: true },
  };
}

function blocked(sessionId: string, block: ReminderBlockCode): DomainError {
  const messages: Record<ReminderBlockCode, string> = {
    session_status: 'Only invited or started sessions can be reminded',
    order_status: 'Reminders only run while the order is "sent"',
    order_type: 'Batch-code orders do not receive platform reminders',
    suppressed: 'Reminders are suppressed for this session',
    notifications_suppressed: 'This order suppresses platform notifications (silent mode)',
    missing_email: 'The respondent has no email address on file',
    count_cap: 'The reminder cap has been reached',
    window_expired: 'The 30-day reminder window has elapsed',
    not_due: 'The 2-day reminder spacing has not elapsed',
  };
  return {
    code: `reminder/${block}`,
    message: messages[block],
    detail: { sessionId, block },
  };
}

function conflict(sessionId: string): DomainError {
  return {
    code: 'reminder/conflict',
    message: 'The session was reminded or changed concurrently — nothing was sent',
    detail: { sessionId },
  };
}

function repoFailure(op: string, cause: unknown): DomainError {
  return {
    code: 'reminder/storage_failed',
    message: `Failed to ${op}`,
    detail: { cause: cause instanceof Error ? cause.message : String(cause) },
  };
}

// ---------------------------------------------------------------------------
// Authorization (spec 05 matrix "Trigger/suppress reminders": super_admin +
// client_admin, client_user per scope — same interpretation as D5's
// invitation actions: a client_user needs `canPlaceOrders` on the order's
// client to drive fulfilment-side actions).
// ---------------------------------------------------------------------------

function canManageReminders(caller: CallerContext, clientId: string): boolean {
  if (caller.kind === 'system') return true;
  if (caller.kind !== 'user') return false; // api_key lands with I1
  if (isSuperAdmin(caller)) return true;
  return caller.roles.some(
    (a) =>
      a.clientId === clientId &&
      (a.role === 'client_admin' || (a.role === 'client_user' && a.permissions.canPlaceOrders))
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Audit entity for sweep summaries: the sweep is a singleton system process,
 * not a row — the nil UUID is its stable identity (`auditEntityRefSchema`
 * requires a UUID id).
 */
const SWEEP_AUDIT_ENTITY = {
  type: 'reminder_sweep',
  id: '00000000-0000-0000-0000-000000000000',
} as const;

/** Cap on sweep batches per run — a hard stop against any pagination bug. */
const MAX_SWEEP_BATCHES = 20;
const DEFAULT_SWEEP_BATCH_SIZE = 200;

interface OrderMailContext {
  product: Product;
  sender: EmailSender;
  host: string;
}

export function createReminderService(deps: ReminderServiceDeps): ReminderService {
  const { sessions, products, customDomains, notifications, audit, config } = deps;
  const now = deps.now ?? (() => new Date());
  const sendWindow = config.sendWindow ?? REMINDER_SEND_WINDOW;
  const batchSize = config.sweepBatchSize ?? DEFAULT_SWEEP_BATCH_SIZE;

  /** Product identity + entry host for one order (spec 11/13). */
  async function mailContext(productId: string, clientId: string): Promise<OrderMailContext | null> {
    const product = await products.findById(productId);
    if (!product) return null;
    const branding = brandingConfigSchema.safeParse(product.branding ?? {});
    const sender =
      branding.success && branding.data.emailFrom ? branding.data.emailFrom : config.platformSender;
    const domains = await customDomains.findActiveByProductId(productId);
    const host = resolveInvitationHost({
      productSlug: product.slug,
      slugBaseDomain: config.slugBaseDomain,
      customDomains: domains,
      clientId,
    });
    return { product, sender, host };
  }

  /**
   * One reminder email through the notification service. The link is the
   * same `/a/{token}` entry URL — deliberately NO PIN (spec 05/13: the PIN
   * was delivered once, in the invitation; admins regenerate, never re-mail).
   */
  async function sendReminder(
    ctx: OrderMailContext,
    record: ReminderSessionRecord,
    email: string,
    reminderNumber: number
  ): Promise<Result<{ notificationId: string }>> {
    const result = await notifications.send({
      kind: 'reminder',
      to: email,
      subject: `Reminder: complete your ${ctx.product.name} assessment`,
      template: REMINDER_TEMPLATE,
      data: {
        entryUrl: buildRespondentEntryUrl(ctx.host, record.token),
        productName: ctx.product.name,
        firstName: record.respondent?.firstName ?? null,
        reminderNumber,
      },
      language: record.language ?? record.order.reportLanguage,
      sender: { from: ctx.sender },
      refs: { orderId: record.orderId, sessionId: record.id },
    });
    if (!result.ok) return err(result.error);
    return ok({ notificationId: result.value.notificationId });
  }

  /** Load + authorize one session for the manual paths. Hides existence. */
  async function loadAuthorized(
    caller: CallerContext,
    sessionId: string
  ): Promise<Result<ReminderSessionRecord>> {
    let record: ReminderSessionRecord | null;
    try {
      record = await sessions.findById(sessionId);
    } catch (cause) {
      return err(repoFailure('read session', cause));
    }
    // Out-of-scope callers get the same answer as a missing id (spec 05:
    // UUID knowledge is never sufficient).
    if (!record || !canManageReminders(caller, record.order.clientId)) {
      return err(sessionNotFound(sessionId));
    }
    return ok(record);
  }

  return {
    async sweep() {
      const at = now();
      const summary: ReminderSweepSummary = { sent: 0, skipped: 0, deferred: 0, failed: [] };
      const seen = new Set<string>();
      const contexts = new Map<string, OrderMailContext | null>();

      for (let batch = 0; batch < MAX_SWEEP_BATCHES; batch++) {
        let due: ReminderSessionRecord[];
        try {
          due = await sessions.listDue({
            now: at,
            minGapMs: REMINDER_MIN_GAP_DAYS * DAY_MS,
            windowMs: REMINDER_STOP_AFTER_DAYS * DAY_MS,
            maxReminders: REMINDER_MAX_COUNT,
            limit: batchSize,
          });
        } catch (cause) {
          return err(repoFailure('query due reminder sessions', cause));
        }
        // Stamped sessions drop out of the due query; deferred/skipped ones
        // do not — the seen-set stops them from being reprocessed this run.
        const fresh = due.filter((record) => !seen.has(record.id));
        if (fresh.length === 0) break;

        for (const record of fresh) {
          seen.add(record.id);
          if (reminderBlock(record, at) !== null) {
            summary.skipped += 1;
            continue;
          }
          const email = record.respondent?.email;
          if (!email) {
            summary.skipped += 1;
            continue;
          }
          const contextKey = `${record.order.productId}:${record.order.clientId}`;
          let ctx = contexts.get(contextKey);
          if (ctx === undefined) {
            try {
              ctx = await mailContext(record.order.productId, record.order.clientId);
            } catch (cause) {
              return err(repoFailure('resolve product mail context', cause));
            }
            contexts.set(contextKey, ctx);
          }
          if (ctx === null) {
            summary.failed.push({ sessionId: record.id, code: 'product_not_found' });
            continue;
          }
          if (!isWithinSendWindow(at, ctx.product.timezone, sendWindow)) {
            summary.deferred += 1;
            continue;
          }
          // Stamp BEFORE send: the CAS on reminder_count makes the losing
          // side of any concurrent run skip instead of double-sending. A
          // stamped-but-failed email is surfaced in `failed` and the session
          // simply waits out the next 2-day cycle.
          let stamped: boolean;
          try {
            stamped = await sessions.markReminderSent(record.id, record.reminderCount, at);
          } catch (cause) {
            return err(repoFailure('stamp reminder', cause));
          }
          if (!stamped) {
            summary.skipped += 1;
            continue;
          }
          const sent = await sendReminder(ctx, record, email, record.reminderCount + 1);
          if (!sent.ok) {
            summary.failed.push({ sessionId: record.id, code: sent.error.code });
            continue;
          }
          summary.sent += 1;
        }
        if (due.length < batchSize) break;
      }

      // The sweep runs hourly — only runs that actually did something are
      // worth an audit row (idle sweeps would drown the log).
      if (summary.sent > 0 || summary.failed.length > 0) {
        const audited = await audit.record(
          { kind: 'system', id: 'system' },
          'reminder.sweep_completed',
          SWEEP_AUDIT_ENTITY,
          {
            sent: summary.sent,
            skipped: summary.skipped,
            deferred: summary.deferred,
            failed: summary.failed.length,
            failedSessionIds: summary.failed.map((failure) => failure.sessionId),
          }
        );
        if (!audited.ok) return err(audited.error);
      }
      return ok(summary);
    },

    async sendManual(caller, input) {
      const parsed = sendManualReminderSchema.safeParse(input);
      if (!parsed.success) return err(validationError(parsed.error.issues));
      const { sessionId } = parsed.data;

      const loaded = await loadAuthorized(caller, sessionId);
      if (!loaded.ok) return err(loaded.error);
      const record = loaded.value;

      const at = now();
      const block = manualReminderBlock(record, at);
      if (block !== null) return err(blocked(sessionId, block));
      const email = record.respondent?.email;
      if (!email) return err(blocked(sessionId, 'missing_email'));

      let ctx: OrderMailContext | null;
      try {
        ctx = await mailContext(record.order.productId, record.order.clientId);
      } catch (cause) {
        return err(repoFailure('resolve product mail context', cause));
      }
      if (!ctx) {
        return err({
          code: 'reminder/product_not_found',
          message: 'The order references an unknown product',
          detail: { sessionId, productId: record.order.productId, permanent: true },
        });
      }

      let stamped: boolean;
      try {
        stamped = await sessions.markReminderSent(sessionId, record.reminderCount, at);
      } catch (cause) {
        return err(repoFailure('stamp reminder', cause));
      }
      if (!stamped) return err(conflict(sessionId));

      const sent = await sendReminder(ctx, record, email, record.reminderCount + 1);
      if (!sent.ok) return err(sent.error);

      const audited = await audit.record(
        { kind: caller.kind, id: caller.id },
        'reminder.manual_sent',
        { type: 'respondent_session', id: sessionId },
        {
          orderId: record.orderId,
          notificationId: sent.value.notificationId,
          reminderCount: record.reminderCount + 1,
        }
      );
      if (!audited.ok) return err(audited.error);
      return ok({
        sessionId,
        notificationId: sent.value.notificationId,
        reminderCount: record.reminderCount + 1,
      });
    },

    async setSuppressed(caller, input) {
      const parsed = setReminderSuppressionSchema.safeParse(input);
      if (!parsed.success) return err(validationError(parsed.error.issues));
      const { sessionId, suppressed } = parsed.data;

      const loaded = await loadAuthorized(caller, sessionId);
      if (!loaded.ok) return err(loaded.error);

      let updated: boolean;
      try {
        updated = await sessions.setSuppressed(sessionId, suppressed, now());
      } catch (cause) {
        return err(repoFailure('update reminder suppression', cause));
      }
      if (!updated) return err(sessionNotFound(sessionId));

      const audited = await audit.record(
        { kind: caller.kind, id: caller.id },
        'reminder.suppression_changed',
        { type: 'respondent_session', id: sessionId },
        { orderId: loaded.value.orderId, suppressed }
      );
      if (!audited.ok) return err(audited.error);
      return ok({ sessionId, suppressed });
    },
  };
}
