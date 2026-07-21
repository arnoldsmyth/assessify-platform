import { z } from 'zod';

/**
 * Scoring domain types (docs/spec/08-scoring-module.md).
 *
 * Everything both sides of the scoring seam agree on lives here: the
 * normalized score document (`ScoreSet`) written to
 * `respondent_sessions.scores`, the `scoring_jobs` lifecycle, the outbound
 * answers payload (option keys / numbers ONLY — never free text, never PII;
 * spec 08 hard rule), and the declarative definition the internal scale-sum
 * engine executes. The ScoringAdapter *interface* lives in
 * `@assessify/adapters` (scoring/types.ts) per the adapter convention; it
 * consumes these schemas.
 */

// ---------------------------------------------------------------------------
// Modes (mirrors the `scoring_mode` pg enum — spec 04, do not reorder)
// ---------------------------------------------------------------------------

export const scoringModes = ['sync_internal', 'async_external'] as const;
export const scoringModeSchema = z.enum(scoringModes);
export type ScoringMode = z.infer<typeof scoringModeSchema>;

/**
 * How an `async_external` engine returns results (owner update 2026-07-14):
 * - `callback`: engine POSTs to our HMAC-verified webhook (spec 08, E2);
 * - `pull`: we poll the engine's API for the finished score document on
 *   demand (rebuilt PRO-D service) — same job lifecycle, no inbound webhook.
 */
export const scoringRetrievalModes = ['callback', 'pull'] as const;
export const scoringRetrievalModeSchema = z.enum(scoringRetrievalModes);
export type ScoringRetrievalMode = z.infer<typeof scoringRetrievalModeSchema>;

// ---------------------------------------------------------------------------
// ScoreSet — the normalized score document (spec 08)
// ---------------------------------------------------------------------------

/** Dimension/band keys are machine identifiers, never display text. */
const scoreKeySchema = z.string().trim().min(1).max(200);

export const scoreSetSchema = z
  .object({
    /** e.g. `{ drive: 72.5, ... }` */
    dimensions: z.record(scoreKeySchema, z.number().finite()),
    /** dimension key → band label KEY (resolved via translations at render). */
    bands: z.record(scoreKeySchema, scoreKeySchema).optional(),
    percentiles: z.record(scoreKeySchema, z.number().finite()).optional(),
    /** Keys into report narrative blocks (spec 09). */
    narrativeKeys: z.array(scoreKeySchema).optional(),
    /** Engine-native payload, stored verbatim. Must never contain PII. */
    raw: z.unknown().optional(),
  })
  .strict();
export type ScoreSet = z.infer<typeof scoreSetSchema>;

// ---------------------------------------------------------------------------
// Outbound answers payload — option keys / numbers only, NO PII (spec 08)
// ---------------------------------------------------------------------------

const answerOptionKeySchema = z.string().trim().min(1).max(200);

/**
 * Value shapes per answerable question type, flattened for the wire:
 * likert/numeric → number; multiple_choice → option key(s); matrix →
 * { rowKey: number }; ranking → ordered option keys; ipsative → most/least
 * option keys. `free_text` answers are deliberately unrepresentable — the
 * scoring service strips them before building the payload (they can contain
 * PII and no engine contract consumes them).
 */
export const scoringAnswerValueSchema = z.union([
  z.number().finite(),
  answerOptionKeySchema,
  z.array(answerOptionKeySchema),
  z.record(answerOptionKeySchema, z.number().finite()),
  z.object({ most: answerOptionKeySchema, least: answerOptionKeySchema }).strict(),
]);
export type ScoringAnswerValue = z.infer<typeof scoringAnswerValueSchema>;

export const scoringAnswersSchema = z.record(z.string().min(1), scoringAnswerValueSchema);
export type ScoringAnswers = z.infer<typeof scoringAnswersSchema>;

// ---------------------------------------------------------------------------
// Internal engine definition (`scoring_config.definition`, sync_internal)
// ---------------------------------------------------------------------------

/** Inclusive score band: `min <= score <= max` → band label key. */
export const scoringBandSchema = z
  .object({
    key: scoreKeySchema,
    min: z.number().finite(),
    max: z.number().finite(),
  })
  .strict();
export type ScoringBand = z.infer<typeof scoringBandSchema>;

export const scoringDimensionDefinitionSchema = z
  .object({
    key: scoreKeySchema,
    /** Question keys whose numeric answers this dimension sums. */
    questionKeys: z.array(z.string().min(1)).min(1),
    bands: z.array(scoringBandSchema).min(1).optional(),
  })
  .strict();
export type ScoringDimensionDefinition = z.infer<typeof scoringDimensionDefinitionSchema>;

/**
 * Declarative definition executed by the built-in internal engine
 * (spec 08 "Internal engines": simple scale sums). Assessment-agnostic —
 * dimensions and question keys come from the product's scoring config,
 * nothing is hardcoded per assessment.
 */
export const internalScoringDefinitionSchema = z
  .object({
    dimensions: z.array(scoringDimensionDefinitionSchema).min(1),
  })
  .strict();
export type InternalScoringDefinition = z.infer<typeof internalScoringDefinitionSchema>;

// ---------------------------------------------------------------------------
// scoring_jobs lifecycle (spec 04 table + spec 08 flow)
// ---------------------------------------------------------------------------

/**
 * queued → dispatched → completed | failed, with `awaiting_callback` between
 * dispatch and completion for async engines (both callback and pull
 * retrieval — E2's watchdog sweeps this state against the per-product SLA).
 * `failed` is re-entered into `queued` only by the admin retry.
 */
export const scoringJobStatuses = [
  'queued',
  'dispatched',
  'awaiting_callback',
  'completed',
  'failed',
] as const;
export const scoringJobStatusSchema = z.enum(scoringJobStatuses);
export type ScoringJobStatus = z.infer<typeof scoringJobStatusSchema>;

export const scoringJobSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    mode: scoringModeSchema,
    status: scoringJobStatusSchema,
    /** HMAC-SHA256 hash of the callback token — never the token itself (E2). */
    callbackTokenHash: z.string().nullable(),
    /** Outbound payload snapshot (ids + option keys/numbers — no PII). */
    requestPayload: z.record(z.unknown()).nullable(),
    /** The validated ScoreSet (or engine failure payload) as stored. */
    responsePayload: z.record(z.unknown()).nullable(),
    /** Machine-readable failure summary — codes and ids only, never PII. */
    error: z.string().nullable(),
    attempts: z.number().int().min(0),
    dispatchedAt: z.date().nullable(),
    completedAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .strict();
export type ScoringJob = z.infer<typeof scoringJobSchema>;
