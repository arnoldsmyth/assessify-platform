import { respondentSessions } from '@assessify/db';
import { respondentAccessSessionSchema, type RespondentAccessSession } from '@assessify/domain';
import { eq } from 'drizzle-orm';

import { getDbHandle } from './client';

/**
 * Data access for respondent token+PIN verification (spec 05, patterns 1/2).
 *
 * Read-only projection of `respondent_sessions`: C1 verification never
 * mutates the session row itself (`started_at`/`status` transitions belong to
 * the questionnaire engine, C2). Failed-PIN counters and lockout timestamps
 * are NOT columns on this table — spec 05 keeps them in a volatile store
 * (Valkey); see `PinAttemptStore` in `../respondent-access/pin-attempt-store`.
 */
export interface RespondentSessionRepository {
  /** Look up a session by its opaque URL token. Null when unknown. */
  findByToken(token: string): Promise<RespondentAccessSession | null>;
  /** Look up a session by primary key (signed-cookie validation). */
  findById(id: string): Promise<RespondentAccessSession | null>;
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
  };
}
