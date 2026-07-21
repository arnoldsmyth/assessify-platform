import { orders, respondents, respondentSessions, type Database } from '@assessify/db';
import type { OrderStatus, OrderType, RespondentSessionStatus } from '@assessify/domain';
import { and, asc, eq, isNotNull, lt, ne, sql } from 'drizzle-orm';

/**
 * Reminder-focused data access for `respondent_sessions` (D6 — spec 13).
 *
 * Deliberately separate from the invitation repository (D5): reminders need
 * the session token (the `/a/{token}` link is re-sent — never a PIN) joined
 * with the ORDER's state and the respondent's email, plus the three reminder
 * bookkeeping columns. Pure persistence with parameterised predicates — the
 * business numbers (2-day gap, 30-day stop, 15-reminder cap) live in the
 * reminder service and arrive here as query parameters, so this module never
 * hard-codes a policy.
 *
 * PII: records carry the respondent email/first name because the service
 * must address the email — they must never end up in logs or audit detail.
 */

export interface ReminderSessionRecord {
  id: string;
  orderId: string;
  /** The `/a/{token}` URL secret (spec 05) — reminder emails re-send the link. */
  token: string;
  status: RespondentSessionStatus;
  language: string | null;
  invitedAt: Date | null;
  /** Anchor fallback for self-registered sessions (group flow) with no invited_at. */
  createdAt: Date;
  reminderCount: number;
  lastReminderAt: Date | null;
  remindersSuppressed: boolean;
  /** The owning order's reminder-relevant state (joined, never a full entity). */
  order: {
    status: OrderStatus;
    type: OrderType;
    clientId: string;
    productId: string;
    reportLanguage: string;
    suppressNotifications: boolean;
  };
  /** Null when the respondent was erased (GDPR) or never registered. */
  respondent: { email: string | null; firstName: string | null } | null;
}

/** Parameters for the due-session sweep query — supplied by the service. */
export interface DueReminderQuery {
  now: Date;
  /** Minimum ms since the last touch (invitation or previous reminder). */
  minGapMs: number;
  /** Maximum ms since the invitation anchor (the permanent stop). */
  windowMs: number;
  /** `reminder_count` must be strictly below this cap. */
  maxReminders: number;
  limit: number;
}

export interface ReminderSessionRepository {
  /**
   * Sessions due an automatic reminder (spec 13): status invited/started,
   * not suppressed, order `sent` (and not batch_code / silent mode), inside
   * the stop window, past the spacing gap, under the cap, with an email on
   * file. Anchor = `invited_at`, falling back to `created_at` for
   * self-registered (group) sessions the platform never invited directly.
   * Oldest last-touch first, capped at `limit`.
   */
  listDue(query: DueReminderQuery): Promise<ReminderSessionRecord[]>;
  /** One session with its order context, regardless of due-ness (manual paths). */
  findById(sessionId: string): Promise<ReminderSessionRecord | null>;
  /**
   * Guarded reminder stamp: increments `reminder_count` and sets
   * `last_reminder_at` only while the row still has `expectedCount`, is
   * invited/started and not suppressed. The compare-and-set makes concurrent
   * sweeps (or a sweep racing a manual send) lose cleanly — the loser gets
   * `false` and must not send.
   */
  markReminderSent(sessionId: string, expectedCount: number, at: Date): Promise<boolean>;
  /** Set the per-session suppression flag. False when the session is missing. */
  setSuppressed(sessionId: string, suppressed: boolean, at: Date): Promise<boolean>;
}

/** Shared select projection — one shape for listDue and findById. */
const recordColumns = {
  id: respondentSessions.id,
  orderId: respondentSessions.orderId,
  token: respondentSessions.token,
  status: respondentSessions.status,
  language: respondentSessions.language,
  invitedAt: respondentSessions.invitedAt,
  createdAt: respondentSessions.createdAt,
  reminderCount: respondentSessions.reminderCount,
  lastReminderAt: respondentSessions.lastReminderAt,
  remindersSuppressed: respondentSessions.remindersSuppressed,
  orderStatus: orders.status,
  orderType: orders.type,
  orderClientId: orders.clientId,
  orderProductId: orders.productId,
  orderReportLanguage: orders.reportLanguage,
  orderSuppressNotifications: orders.suppressNotifications,
  respondentId: respondentSessions.respondentId,
  respondentEmail: respondents.email,
  respondentFirstName: respondents.firstName,
};

interface RecordRow {
  id: string;
  orderId: string;
  token: string;
  status: string;
  language: string | null;
  invitedAt: Date | null;
  createdAt: Date;
  reminderCount: number;
  lastReminderAt: Date | null;
  remindersSuppressed: boolean;
  orderStatus: string;
  orderType: string;
  orderClientId: string;
  orderProductId: string;
  orderReportLanguage: string;
  orderSuppressNotifications: boolean;
  respondentId: string | null;
  respondentEmail: string | null;
  respondentFirstName: string | null;
}

function toRecord(row: RecordRow): ReminderSessionRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    token: row.token,
    status: row.status as RespondentSessionStatus,
    language: row.language,
    invitedAt: row.invitedAt,
    createdAt: row.createdAt,
    reminderCount: row.reminderCount,
    lastReminderAt: row.lastReminderAt,
    remindersSuppressed: row.remindersSuppressed,
    order: {
      status: row.orderStatus as OrderStatus,
      type: row.orderType as OrderType,
      clientId: row.orderClientId,
      productId: row.orderProductId,
      reportLanguage: row.orderReportLanguage,
      suppressNotifications: row.orderSuppressNotifications,
    },
    respondent:
      row.respondentId === null
        ? null
        : { email: row.respondentEmail, firstName: row.respondentFirstName },
  };
}

export function createReminderSessionRepository(db: Database): ReminderSessionRepository {
  return {
    async listDue(query) {
      // Anchor = invitation moment (or self-registration for group sessions);
      // last touch = the most recent of anchor and previous reminder.
      const anchor = sql`coalesce(${respondentSessions.invitedAt}, ${respondentSessions.createdAt})`;
      const lastTouch = sql`coalesce(${respondentSessions.lastReminderAt}, ${respondentSessions.invitedAt}, ${respondentSessions.createdAt})`;
      const dueBefore = new Date(query.now.getTime() - query.minGapMs);
      const windowStart = new Date(query.now.getTime() - query.windowMs);
      const rows = await db
        .select(recordColumns)
        .from(respondentSessions)
        .innerJoin(orders, eq(respondentSessions.orderId, orders.id))
        .leftJoin(respondents, eq(respondentSessions.respondentId, respondents.id))
        .where(
          and(
            sql`${respondentSessions.status} in ('invited', 'started')`,
            eq(respondentSessions.remindersSuppressed, false),
            lt(respondentSessions.reminderCount, query.maxReminders),
            eq(orders.status, 'sent'),
            // Spec 13: batch-code orders get no automatic reminders; silent
            // (suppress_notifications) orders send no platform email at all.
            ne(orders.type, 'batch_code'),
            eq(orders.suppressNotifications, false),
            isNotNull(respondents.email),
            sql`${lastTouch} <= ${dueBefore}`,
            sql`${anchor} >= ${windowStart}`
          )
        )
        .orderBy(asc(lastTouch), asc(respondentSessions.id))
        .limit(query.limit);
      return rows.map((row) => toRecord(row as RecordRow));
    },

    async findById(sessionId) {
      const rows = await db
        .select(recordColumns)
        .from(respondentSessions)
        .innerJoin(orders, eq(respondentSessions.orderId, orders.id))
        .leftJoin(respondents, eq(respondentSessions.respondentId, respondents.id))
        .where(eq(respondentSessions.id, sessionId))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row as RecordRow) : null;
    },

    async markReminderSent(sessionId, expectedCount, at) {
      const rows = await db
        .update(respondentSessions)
        .set({
          reminderCount: sql`${respondentSessions.reminderCount} + 1`,
          lastReminderAt: at,
          updatedAt: at,
        })
        .where(
          and(
            eq(respondentSessions.id, sessionId),
            eq(respondentSessions.reminderCount, expectedCount),
            sql`${respondentSessions.status} in ('invited', 'started')`,
            eq(respondentSessions.remindersSuppressed, false)
          )
        )
        .returning({ id: respondentSessions.id });
      return rows.length > 0;
    },

    async setSuppressed(sessionId, suppressed, at) {
      const rows = await db
        .update(respondentSessions)
        .set({ remindersSuppressed: suppressed, updatedAt: at })
        .where(eq(respondentSessions.id, sessionId))
        .returning({ id: respondentSessions.id });
      return rows.length > 0;
    },
  };
}
