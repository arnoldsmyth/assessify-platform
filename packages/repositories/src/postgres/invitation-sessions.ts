import { respondents, respondentSessions, type Database } from '@assessify/db';
import type { RespondentSessionStatus } from '@assessify/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';

/**
 * Invitation-focused data access for `respondent_sessions` (D5 — spec 05/06).
 *
 * Deliberately separate from `OrderRepository.findSessions` (whose admin
 * projection omits the token) and from `RespondentSessionRepository` (C1's
 * verification reads): invitation dispatch is the ONE flow that needs the
 * session token together with the respondent's email, and the only writer of
 * `pin_hash`. Pure persistence — eligibility rules (which sessions to invite
 * or resend) live in the invitation service. Infrastructure failures throw;
 * the service converts them to Results.
 *
 * PII: records carry the respondent email/first name because the service
 * must address the email — they must never end up in logs or audit detail.
 */

export interface InvitationSessionRecord {
  id: string;
  orderId: string;
  /** The `/a/{token}` URL secret (spec 05). Only the invitation flow reads it. */
  token: string;
  status: RespondentSessionStatus;
  language: string | null;
  invitedAt: Date | null;
  /** Null when the respondent was erased (GDPR) or not yet registered. */
  respondent: { email: string | null; firstName: string | null } | null;
}

export interface InvitationSessionRepository {
  /** All sessions on the order with respondent contact identity, oldest first. */
  listByOrder(orderId: string): Promise<InvitationSessionRecord[]>;
  /**
   * First-dispatch write: `created` → `invited`, storing the bcrypt PIN hash
   * and `invited_at`. Status-guarded (returns false when the session was
   * already invited or is missing) so concurrent dispatch runs never
   * double-invite. `pinHash` is null only for suppressed-notification orders
   * (silent mode — no email means no PIN to hash).
   */
  markInvited(sessionId: string, pinHash: string | null, at: Date): Promise<boolean>;
  /**
   * Resend write: replace the PIN hash on an already-invited (or started)
   * session — spec 05 "same token, regenerated PIN". Returns false when the
   * session is missing or not in a resendable status.
   */
  replacePinHash(sessionId: string, pinHash: string, at: Date): Promise<boolean>;
}

export function createInvitationSessionRepository(db: Database): InvitationSessionRepository {
  return {
    async listByOrder(orderId) {
      const rows = await db
        .select({
          id: respondentSessions.id,
          orderId: respondentSessions.orderId,
          token: respondentSessions.token,
          status: respondentSessions.status,
          language: respondentSessions.language,
          invitedAt: respondentSessions.invitedAt,
          respondentId: respondentSessions.respondentId,
          respondentEmail: respondents.email,
          respondentFirstName: respondents.firstName,
        })
        .from(respondentSessions)
        .leftJoin(respondents, eq(respondentSessions.respondentId, respondents.id))
        .where(eq(respondentSessions.orderId, orderId))
        .orderBy(asc(respondentSessions.createdAt), asc(respondentSessions.id));
      return rows.map(
        (row): InvitationSessionRecord => ({
          id: row.id,
          orderId: row.orderId,
          token: row.token,
          status: row.status as RespondentSessionStatus,
          language: row.language,
          invitedAt: row.invitedAt,
          respondent:
            row.respondentId === null
              ? null
              : { email: row.respondentEmail, firstName: row.respondentFirstName },
        })
      );
    },

    async markInvited(sessionId, pinHash, at) {
      const rows = await db
        .update(respondentSessions)
        .set({ status: 'invited', pinHash, invitedAt: at, updatedAt: at })
        .where(
          and(eq(respondentSessions.id, sessionId), eq(respondentSessions.status, 'created'))
        )
        .returning({ id: respondentSessions.id });
      return rows.length > 0;
    },

    async replacePinHash(sessionId, pinHash, at) {
      const rows = await db
        .update(respondentSessions)
        .set({ pinHash, updatedAt: at })
        .where(
          and(
            eq(respondentSessions.id, sessionId),
            inArray(respondentSessions.status, ['invited', 'started'])
          )
        )
        .returning({ id: respondentSessions.id });
      return rows.length > 0;
    },
  };
}
