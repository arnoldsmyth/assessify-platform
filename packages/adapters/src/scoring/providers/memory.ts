import type { ScoringMode } from '@assessify/domain';

import type {
  ScoringAdapter,
  ScoringFetchInput,
  ScoringFetchOutcome,
  ScoringInput,
  ScoringOutcome,
} from '../types';

/**
 * In-memory ScoringAdapter for tests: records every `score`/`fetchResult`
 * call and replays programmed outcomes FIFO (falling back to a benign
 * default), mirroring the MemoryMailer conventions. This is the reference
 * implementation of the ScoringAdapter contract — including the optional
 * pull-retrieval `fetchResult` — so services can exercise every outcome path
 * without a real engine.
 */
export interface MemoryScoringAdapter extends ScoringAdapter {
  /** Every input passed to score(), in order. */
  readonly scored: readonly ScoringInput[];
  /** Every input passed to fetchResult(), in order. */
  readonly fetched: readonly ScoringFetchInput[];
  /** Program the outcome for the next un-programmed score() call (FIFO). */
  queueOutcome(outcome: ScoringOutcome): void;
  /** Program the outcome for the next un-programmed fetchResult() call (FIFO). */
  queueFetchOutcome(outcome: ScoringFetchOutcome): void;
  /** Make subsequent score() calls reject with the given error (null to reset). */
  failWith(error: Error | null): void;
  /** Forget recorded calls and programmed outcomes. */
  reset(): void;
}

/** Default score() outcome: an empty-but-valid sync result. */
const DEFAULT_OUTCOME: ScoringOutcome = { kind: 'sync_result', scores: { dimensions: {} } };

export function createMemoryScoringAdapter(
  options: { mode?: ScoringMode } = {}
): MemoryScoringAdapter {
  const scored: ScoringInput[] = [];
  const fetched: ScoringFetchInput[] = [];
  const outcomes: ScoringOutcome[] = [];
  const fetchOutcomes: ScoringFetchOutcome[] = [];
  let failure: Error | null = null;

  return {
    mode: options.mode ?? 'sync_internal',
    scored,
    fetched,
    queueOutcome(outcome) {
      outcomes.push(outcome);
    },
    queueFetchOutcome(outcome) {
      fetchOutcomes.push(outcome);
    },
    failWith(error) {
      failure = error;
    },
    reset() {
      scored.length = 0;
      fetched.length = 0;
      outcomes.length = 0;
      fetchOutcomes.length = 0;
      failure = null;
    },
    async score(input) {
      if (failure) throw failure;
      scored.push(input);
      return outcomes.shift() ?? DEFAULT_OUTCOME;
    },
    async fetchResult(input) {
      fetched.push(input);
      return fetchOutcomes.shift() ?? { kind: 'pending' };
    },
  };
}
