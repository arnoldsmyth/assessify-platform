/**
 * Scoring adapter contract (docs/spec/08-scoring-module.md, appendix
 * architecture layers §4).
 *
 * The adapter only knows *how* to score — the scoring SERVICE decides *when*
 * to dispatch, builds the (PII-free) input from the submitted response, and
 * applies outcomes to jobs/sessions/orders. Providers live in ./providers/
 * and are wired at composition roots; services import these types only
 * (enforced by .dependency-cruiser.cjs).
 *
 * Three engine modes share this one interface:
 *  - `sync_internal`: `score()` returns `sync_result` immediately
 *    (providers/internal-sync.ts);
 *  - `async_external` + `callback` retrieval: `score()` returns
 *    `accepted_async`; the engine later POSTs to our HMAC-verified webhook
 *    (E2);
 *  - `async_external` + `pull` retrieval (owner update 2026-07-14, rebuilt
 *    PRO-D service): `score()` returns `accepted_async`; the finished score
 *    document is retrieved on demand via `fetchResult()` (E2's
 *    poller/watchdog drives it; the callback route never fires).
 *
 * Hard rule (spec 08): inputs carry ids, option keys and numbers only —
 * never respondent PII — unless the engine's documented payload contract
 * requires a specific field (`respondentMeta`).
 */
import type {
  ScoreSet,
  ScoringAnswers,
  ScoringConfig,
  ScoringMode,
  ScoringRetrievalMode,
} from '@assessify/domain';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ScoringProductRef {
  id: string;
  /** Engine-facing identifiers (`products.external_ids`), e.g. legacy PRO-D codes. */
  externalIds: Record<string, string>;
}

export interface ScoringQuestionnaireRef {
  /** Stable definition key (spec 07). */
  key: string;
  version: number;
  /** 'self' | rater variant key. */
  variant: string;
}

/** Async callback coordinates — set only for `callback` retrieval (E2). */
export interface ScoringCallbackRef {
  url: string;
  /** Random 256-bit token; only its HMAC hash is stored on the job. */
  token: string;
}

export interface ScoringInput {
  jobId: string;
  sessionId: string;
  product: ScoringProductRef;
  questionnaire: ScoringQuestionnaireRef;
  /**
   * Visible answers only, option keys / numbers — NO PII. Hidden-flagged and
   * free-text answers are stripped by the scoring service before dispatch.
   */
  answers: ScoringAnswers;
  /** Only fields the engine contract requires, documented per product. */
  respondentMeta?: { language: string; gender?: string };
  callback?: ScoringCallbackRef;
  /** The product's `scoring_config` (engine key, endpoint, timeouts, ...). */
  config: ScoringConfig;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type ScoringOutcome =
  /** Scores computed inline (sync_internal, or an external engine answering synchronously). */
  | { kind: 'sync_result'; scores: ScoreSet }
  /** Engine accepted the request; results arrive later via `retrieval`. */
  | { kind: 'accepted_async'; retrieval: ScoringRetrievalMode }
  /** Engine rejected/failed. `retryable: false` parks the job immediately. */
  | { kind: 'failed'; retryable: boolean; error: string };

/** Pull-retrieval request: everything needed to locate the result remotely. */
export interface ScoringFetchInput {
  jobId: string;
  sessionId: string;
  product: ScoringProductRef;
  config: ScoringConfig;
}

export type ScoringFetchOutcome =
  /** Engine is still computing — poll again later (watchdog enforces the SLA). */
  | { kind: 'pending' }
  | { kind: 'result'; scores: ScoreSet }
  | { kind: 'failed'; retryable: boolean; error: string };

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ScoringAdapter {
  /** Which `products.scoring_config.mode` this adapter serves. */
  readonly mode: ScoringMode;
  /** Called by the worker processing a `scoring.dispatch` job. */
  score(input: ScoringInput): Promise<ScoringOutcome>;
  /**
   * Retrieve the result of a previously accepted job (pull retrieval only).
   * Optional: sync/callback providers never implement it.
   */
  fetchResult?(input: ScoringFetchInput): Promise<ScoringFetchOutcome>;
}

/**
 * One internal engine (spec 08 "Internal engines"): a pure function from the
 * PII-free input to a normalized ScoreSet. Throw {@link ScoringAdapterError}
 * for typed failures; the internal-sync provider maps throws to `failed`
 * outcomes and validates returned ScoreSets at the boundary.
 */
export type ScoringEngine = (input: ScoringInput) => ScoreSet | Promise<ScoreSet>;

// ---------------------------------------------------------------------------
// Errors (never contain PII)
// ---------------------------------------------------------------------------

/** Thrown by scoring providers/engines when scoring fails. */
export class ScoringAdapterError extends Error {
  constructor(
    message: string,
    /** False when retrying can never succeed (bad config, rejected payload). */
    readonly retryable: boolean = true
  ) {
    super(message);
    this.name = 'ScoringAdapterError';
  }
}
