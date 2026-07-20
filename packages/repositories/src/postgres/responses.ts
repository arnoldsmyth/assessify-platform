import { questionnaireResponses, type Database } from '@assessify/db';
import {
  answersPatchSchema,
  emptyResponseProgress,
  newQuestionnaireResponseSchema,
  questionnaireResponseSchema,
  responseProgressSchema,
  type AnswersPatch,
  type NewQuestionnaireResponse,
  type QuestionnaireResponse,
  type ResponseProgress,
} from '@assessify/domain';
import { and, eq, sql } from 'drizzle-orm';

import { getDbHandle } from './client';

/**
 * Questionnaire response store (A4 re-scope: Neon Postgres jsonb, replacing
 * the Firestore `responses/{sessionId}` collection).
 *
 * Write model for C2 (spec 07 progress save/resume):
 *  - `getOrCreate` on first questionnaire load (resume-safe);
 *  - `patchAnswers` on every debounced answer flush;
 *  - `updateProgress` when the server recomputes section position/counts;
 *  - `markSubmitted` exactly once at submit — answers are immutable after.
 *
 * Immutability is a *service-layer* rule (the service reads `status` before
 * writing); the `status = 'draft'` guards here are a race-free backstop, so
 * writes against a submitted response affect zero rows and return null.
 */
export interface ResponseRepository {
  findBySessionId(sessionId: string): Promise<QuestionnaireResponse | null>;
  /** Idempotent create: returns the existing row if the session already has one. */
  getOrCreate(input: NewQuestionnaireResponse): Promise<QuestionnaireResponse>;
  /**
   * Merge the given answer records into `answers` (top-level jsonb merge, so
   * each answer key is replaced atomically). Returns the updated response, or
   * null when the session has no draft response.
   */
  patchAnswers(sessionId: string, patch: AnswersPatch): Promise<QuestionnaireResponse | null>;
  /** Replace the progress snapshot (and optionally the display language). */
  updateProgress(
    sessionId: string,
    progress: ResponseProgress,
    options?: { language?: string }
  ): Promise<QuestionnaireResponse | null>;
  /**
   * draft → submitted, exactly once. Returns null when there is no draft
   * response (missing session or already submitted).
   */
  markSubmitted(sessionId: string, completedAt?: Date): Promise<QuestionnaireResponse | null>;
}

type ResponseRow = typeof questionnaireResponses.$inferSelect;

/** Zod-validate on the way out — rows map to domain entities, never raw jsonb. */
function toEntity(row: ResponseRow): QuestionnaireResponse {
  return questionnaireResponseSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    orderId: row.orderId,
    productId: row.productId,
    questionnaireVersionId: row.questionnaireVersionId,
    language: row.language,
    status: row.status,
    answers: row.answers,
    progress: row.progress,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class DrizzleResponseRepository implements ResponseRepository {
  constructor(private readonly db: Database) {}

  async findBySessionId(sessionId: string): Promise<QuestionnaireResponse | null> {
    const rows = await this.db
      .select()
      .from(questionnaireResponses)
      .where(eq(questionnaireResponses.sessionId, sessionId))
      .limit(1);
    const row = rows[0];
    return row ? toEntity(row) : null;
  }

  async getOrCreate(input: NewQuestionnaireResponse): Promise<QuestionnaireResponse> {
    const validated = newQuestionnaireResponseSchema.parse(input);
    const now = new Date();
    const rows = await this.db
      .insert(questionnaireResponses)
      .values({
        id: validated.id,
        sessionId: validated.sessionId,
        orderId: validated.orderId,
        productId: validated.productId,
        questionnaireVersionId: validated.questionnaireVersionId,
        language: validated.language ?? null,
        status: 'draft',
        answers: {},
        progress: { ...emptyResponseProgress },
        startedAt: validated.startedAt ?? now,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: questionnaireResponses.sessionId })
      .returning();
    const inserted = rows[0];
    if (inserted) return toEntity(inserted);

    // Conflict path: another request already created the row — resume it.
    const existing = await this.findBySessionId(validated.sessionId);
    if (!existing) {
      throw new Error('questionnaire_responses insert conflicted but no row was found');
    }
    return existing;
  }

  async patchAnswers(
    sessionId: string,
    patch: AnswersPatch
  ): Promise<QuestionnaireResponse | null> {
    // Zod-validate on the way in: only well-formed answer records reach jsonb.
    const validated = answersPatchSchema.parse(patch);
    const rows = await this.db
      .update(questionnaireResponses)
      .set({
        // Top-level jsonb merge: replaces exactly the patched question keys,
        // leaving concurrent flushes of other keys intact (no read-modify-write).
        answers: sql`${questionnaireResponses.answers} || ${JSON.stringify(validated)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(questionnaireResponses.sessionId, sessionId),
          eq(questionnaireResponses.status, 'draft')
        )
      )
      .returning();
    const row = rows[0];
    return row ? toEntity(row) : null;
  }

  async updateProgress(
    sessionId: string,
    progress: ResponseProgress,
    options: { language?: string } = {}
  ): Promise<QuestionnaireResponse | null> {
    const validated = responseProgressSchema.parse(progress);
    const rows = await this.db
      .update(questionnaireResponses)
      .set({
        progress: validated,
        ...(options.language === undefined ? {} : { language: options.language }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(questionnaireResponses.sessionId, sessionId),
          eq(questionnaireResponses.status, 'draft')
        )
      )
      .returning();
    const row = rows[0];
    return row ? toEntity(row) : null;
  }

  async markSubmitted(
    sessionId: string,
    completedAt: Date = new Date()
  ): Promise<QuestionnaireResponse | null> {
    const rows = await this.db
      .update(questionnaireResponses)
      .set({ status: 'submitted', completedAt, updatedAt: completedAt })
      .where(
        and(
          eq(questionnaireResponses.sessionId, sessionId),
          eq(questionnaireResponses.status, 'draft')
        )
      )
      .returning();
    const row = rows[0];
    return row ? toEntity(row) : null;
  }
}

/** Composition helper mirroring createRoleAssignmentRepository. */
export function createResponseRepository(connectionString: string): ResponseRepository {
  const { db } = getDbHandle(connectionString);
  return new DrizzleResponseRepository(db);
}
