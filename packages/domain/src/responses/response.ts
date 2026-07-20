import { z } from 'zod';

import { languageTagSchema } from '../products';

/**
 * Questionnaire response store (A4 re-scope, 2026-07-14: Neon Postgres jsonb
 * replaces the Firestore `responses/{sessionId}` collection from spec 04).
 *
 * One response document per respondent session. The `answers` map is keyed by
 * question key (spec 07: keys are stable across versions) and stores option
 * KEYS, never display text. Value shapes per question type follow the
 * normative table in docs/spec/07-questionnaire-engine.md.
 */

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** UUID (v7 in practice — generated via `uuidv7()` from this package). */
const uuidSchema = z.string().uuid();

/**
 * Timestamps *inside* jsonb payloads are ISO-8601 strings (jsonb has no
 * timestamptz); row-level timestamps stay `timestamptz` and surface as `Date`.
 */
export const isoTimestampSchema = z.string().datetime({ offset: true });

/** Stable question/section/option key (spec 07 definition schema). */
export const questionKeySchema = z.string().trim().min(1).max(200);

const optionKeySchema = z.string().trim().min(1).max(200);

/** Question types that can carry an answer ('content' never does — spec 07). */
export const answerableQuestionTypeSchema = z.enum([
  'likert',
  'multiple_choice',
  'matrix',
  'numeric',
  'ranking',
  'free_text',
  'ipsative_most_least',
]);
export type AnswerableQuestionType = z.infer<typeof answerableQuestionTypeSchema>;

// ---------------------------------------------------------------------------
// Answer records — `answers[questionKey]` = { type, value, answeredAt, hidden? }
// ---------------------------------------------------------------------------

const answerRecordBase = {
  answeredAt: isoTimestampSchema,
  /**
   * Set at submit for answers whose question is currently hidden by `showIf`
   * branching — retained but flagged (spec 07 "Rendering & flow").
   */
  hidden: z.boolean().optional(),
};

/** likert / numeric → number */
const numberValue = z.number().finite();

export const answerRecordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('likert'), value: numberValue, ...answerRecordBase }).strict(),
  z.object({ type: z.literal('numeric'), value: numberValue, ...answerRecordBase }).strict(),
  z
    .object({
      type: z.literal('multiple_choice'),
      /** single → optionKey; multi → optionKey[] */
      value: z.union([optionKeySchema, z.array(optionKeySchema)]),
      ...answerRecordBase,
    })
    .strict(),
  z
    .object({
      type: z.literal('matrix'),
      /** { [rowKey]: number } */
      value: z.record(optionKeySchema, numberValue),
      ...answerRecordBase,
    })
    .strict(),
  z
    .object({
      type: z.literal('ranking'),
      /** option keys in ranked order */
      value: z.array(optionKeySchema).min(1),
      ...answerRecordBase,
    })
    .strict(),
  z
    .object({ type: z.literal('free_text'), value: z.string().max(20_000), ...answerRecordBase })
    .strict(),
  z
    .object({
      type: z.literal('ipsative_most_least'),
      value: z
        .object({ most: optionKeySchema, least: optionKeySchema })
        .strict()
        .refine((v) => v.most !== v.least, {
          message: 'Most and Least cannot be the same item',
        }),
      ...answerRecordBase,
    })
    .strict(),
]);
export type AnswerRecord = z.infer<typeof answerRecordSchema>;

/** The full `answers` jsonb column: question key → answer record. */
export const answersMapSchema = z.record(questionKeySchema, answerRecordSchema);
export type AnswersMap = z.infer<typeof answersMapSchema>;

/**
 * Partial-update payload: only the keys being written. Applied in SQL as a
 * top-level jsonb merge (`answers || patch`), so each answer record is an
 * atomic replace — see DrizzleResponseRepository.patchAnswers.
 */
export const answersPatchSchema = answersMapSchema.refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'Patch must contain at least one answer' }
);
export type AnswersPatch = z.infer<typeof answersPatchSchema>;

// ---------------------------------------------------------------------------
// Progress — recomputed server-side on every save (spec 07)
// ---------------------------------------------------------------------------

export const responseProgressSchema = z
  .object({
    /** Section the respondent is on; null before the first section renders. */
    currentSectionKey: questionKeySchema.nullable(),
    /** Answered count of currently-visible required questions. */
    answeredCount: z.number().int().min(0),
    /** Total currently-visible required questions. */
    totalCount: z.number().int().min(0),
  })
  .strict();
export type ResponseProgress = z.infer<typeof responseProgressSchema>;

export const emptyResponseProgress: ResponseProgress = {
  currentSectionKey: null,
  answeredCount: 0,
  totalCount: 0,
};

// ---------------------------------------------------------------------------
// Response entity
// ---------------------------------------------------------------------------

/** draft → submitted, exactly once; answers are immutable after submit. */
export const responseStatusSchema = z.enum(['draft', 'submitted']);
export type ResponseStatus = z.infer<typeof responseStatusSchema>;

export const questionnaireResponseSchema = z
  .object({
    id: uuidSchema,
    /** One row per respondent session (`respondent_sessions.id`). */
    sessionId: uuidSchema,
    orderId: uuidSchema,
    productId: uuidSchema,
    questionnaireVersionId: uuidSchema,
    /** Respondent's display language at last save; answers are language-agnostic. */
    language: languageTagSchema.nullable(),
    status: responseStatusSchema,
    answers: answersMapSchema,
    progress: responseProgressSchema,
    startedAt: z.date(),
    /** Set exactly once at submit; mirrors `respondent_sessions.completed_at`. */
    completedAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();
export type QuestionnaireResponse = z.infer<typeof questionnaireResponseSchema>;

/** Creation payload — a fresh draft with empty answers/progress. */
export const newQuestionnaireResponseSchema = z
  .object({
    id: uuidSchema,
    sessionId: uuidSchema,
    orderId: uuidSchema,
    productId: uuidSchema,
    questionnaireVersionId: uuidSchema,
    language: languageTagSchema.nullish(),
    startedAt: z.date().optional(),
  })
  .strict();
export type NewQuestionnaireResponse = z.infer<typeof newQuestionnaireResponseSchema>;
