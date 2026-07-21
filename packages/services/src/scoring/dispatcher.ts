import { ok, type Result, type ScoringJobStatus } from '@assessify/domain';

/**
 * Narrow port through which the questionnaire session service (C2) triggers
 * scoring on submit — the session service never sees scoring logic, only
 * this seam (spec 08 flow: "session completed → scoringService.dispatch").
 * The full ScoringService implements it structurally.
 */

export interface ScoringDispatchReceipt {
  jobId: string;
  status: ScoringJobStatus;
}

export interface ScoringDispatcher {
  /**
   * Create (or return the existing) scoring job for a completed session and
   * enqueue its processing. `null` only from the no-op dispatcher.
   */
  dispatch(sessionId: string): Promise<Result<ScoringDispatchReceipt | null>>;
}

/**
 * Default when a composition root has no scoring wiring (e.g. no job queue in
 * dev): submit succeeds, nothing is dispatched. Admin re-scoring can always
 * catch up later because raw answers are immutable (spec 08).
 */
export const noopScoringDispatcher: ScoringDispatcher = {
  async dispatch(): Promise<Result<null>> {
    return ok(null);
  },
};
