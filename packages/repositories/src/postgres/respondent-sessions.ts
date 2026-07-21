import { respondentSessions } from '@assessify/db';
import { respondentAccessSessionSchema, type RespondentAccessSession } from '@assessify/domain';
import { and, eq, inArray } from 'drizzle-orm';

import { getDbHandle } from './client';

/**
 * Data access for respondent sessions (spec 05 access + spec 07 flow).
 *
 * C1 verification only reads; the questionnaire engine (C2) owns the two
 * fulfilment transitions on this table: `markStarted` when the questionnaire
 * first loads and `markCompleted` at submit (spec 07 "Completion"). Both are
 * status-guarded so they are race-free and never rewind later lifecycle
 * states (`awaiting_scores`, `scored`, ...). Failed-PIN counters and lockout
 * timestamps are NOT columns on this table — spec 05 keeps them in a volatile
 * store (Valkey); see `PinAttemptStore` in
 * `../respondent-access/pin-attempt-store`.
 */
export interface RespondentSessionRepository {
  /** Look up a session by its opaque URL token. Null when unknown. */
  findByToken(token: string): Promise<RespondentAccessSession | null>;
  /** Look up a session by primary key (signed-cookie validation). */
  findById(id: string): Promise<RespondentAccessSession | null>;
  /**
   * created/invited → started (sets `started_at` once). No-op for sessions
   * already started or further along.
   */
  markStarted(id: string, at: Date): Promise<void>;
  /**
   * created/invited/started → completed (sets `completed_at`). No-op once the
   * session is completed or beyond.
   */
  markCompleted(id: string, at: Date): Promise<void>;
  /**
   * completed → awaiting_scores (scoring dispatched — spec 08 flow). No-op
   * for sessions already awaiting scores or further along; returns whether a
   * row transitioned.
   */
  markAwaitingScores(id: string, at: Date): Promise<boolean>;
  /**
   * completed/awaiting_scores/scored → scored: writes the validated ScoreSet
   * to `scores` + `scored_at` (spec 08 applyScores; re-entry from `scored`
   * supports admin re-scoring — raw answers are immutable). Returns whether a
   * row was written.
   */
  applyScores(id: string, scores: Record<string, unknown>, at: Date): Promise<boolean>;
}

type SessionRow = typeof respondentSessions.$inferSelect;

/** Zod-validate at the boundary: rows map to domain entities, never raw. */
function toEntity(row: SessionRow): RespondentAccessSession {
  return respondentAccessSessionSchema.parse({
    id: row.id,
    orderId: row.orderId,
    respondentId: row.respondentId,
    token: row.token,
    pinHash: row.pinHash,
    status: row.status,
    isFocal: row.isFocal,
    questionnaireVersionId: row.questionnaireVersionId,
    language: row.language,
    invitedAt: row.invitedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  });
}

export function createRespondentSessionRepository(
  connectionString: string
): RespondentSessionRepository {
  const { db } = getDbHandle(connectionString);

  async function findOne(
    where: ReturnType<typeof eq>
  ): Promise<RespondentAccessSession | null> {
    const rows = await db.select().from(respondentSessions).where(where).limit(1);
    const row = rows[0];
    return row ? toEntity(row) : null;
  }

  return {
    findByToken(token: string) {
      return findOne(eq(respondentSessions.token, token));
    },
    findById(id: string) {
      return findOne(eq(respondentSessions.id, id));
    },
    async markStarted(id: string, at: Date) {
      await db
        .update(respondentSessions)
        .set({ status: 'started', startedAt: at, updatedAt: at })
        .where(
          and(
            eq(respondentSessions.id, id),
            inArray(respondentSessions.status, ['created', 'invited'])
          )
        );
    },
    async markCompleted(id: string, at: Date) {
      await db
        .update(respondentSessions)
        .set({ status: 'completed', completedAt: at, updatedAt: at })
        .where(
          and(
            eq(respondentSessions.id, id),
            inArray(respondentSessions.status, ['created', 'invited', 'started'])
          )
        );
    },
    async markAwaitingScores(id: string, at: Date) {
      const rows = await db
        .update(respondentSessions)
        .set({ status: 'awaiting_scores', updatedAt: at })
        .where(
          and(eq(respondentSessions.id, id), eq(respondentSessions.status, 'completed'))
        )
        .returning({ id: respondentSessions.id });
      return rows.length > 0;
    },
    async applyScores(id: string, scores: Record<string, unknown>, at: Date) {
      const rows = await db
        .update(respondentSessions)
        .set({ status: 'scored', scores, scoredAt: at, updatedAt: at })
        .where(
          and(
            eq(respondentSessions.id, id),
            inArray(respondentSessions.status, ['completed', 'awaiting_scores', 'scored'])
          )
        )
        .returning({ id: respondentSessions.id });
      return rows.length > 0;
    },
  };
}
