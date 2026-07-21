import { respondents, type Database } from '@assessify/db';
import { eq } from 'drizzle-orm';

/**
 * Read-only access to `respondents` (spec 04 parties: persistent identity
 * across a lifetime of assessments; D2 find-or-creates rows by email at
 * order placement).
 *
 * Exists for the E2 scoring path ONLY: external engines whose documented
 * payload contract requires respondent identity (Pro-Logic registration —
 * the spec 00 PII exception). `id` is the stable external correlation key
 * (`external_id`) that dedupes per-person royalty billing across orders and
 * rescores — it must never be substituted with order/session ids. Identity
 * values are handed to the adapter and nowhere else: never logged, never
 * audited, never snapshotted.
 */
export interface RespondentIdentity {
  id: string;
  /** Nullable — PII deletion may have cleared them. */
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  language: string | null;
}

export interface RespondentRepository {
  findById(id: string): Promise<RespondentIdentity | null>;
}

export function createRespondentRepository(db: Database): RespondentRepository {
  return {
    async findById(id) {
      const rows = await db
        .select({
          id: respondents.id,
          email: respondents.email,
          firstName: respondents.firstName,
          lastName: respondents.lastName,
          language: respondents.language,
        })
        .from(respondents)
        .where(eq(respondents.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
