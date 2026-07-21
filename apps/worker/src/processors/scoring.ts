/**
 * `scoring.dispatch` processor — the worker half of spec 08's flow: the
 * scoring service already created the `queued` scoring_jobs row; this hands
 * the job id back to `scoringService.processJob`, which loads the submitted
 * answers, calls the product's scoring adapter and applies the outcome
 * (scores → session, lifecycle → job, failures → order `scoring_error`).
 *
 * Processors stay thin (03-architecture.md): call the service, map its
 * Result. Error mapping:
 * - service unavailable / job missing / permanent engine failure →
 *   `UnrecoverableError` (retrying can never succeed, park in the failed set);
 * - anything else (`scoring/attempt_failed`, transient infra) → normal throw,
 *   retried per the queue's default backoff (spec 08 "retry w/ backoff up to
 *   maxAttempts" — the service counts attempts on the job row).
 *
 * Log/error strings carry job ids and error codes only — never answers or
 * respondent data.
 */
import { UnrecoverableError } from 'bullmq';
import type { JobPayload } from '@assessify/domain';
import type { ScoringService } from '@assessify/services';

export interface ScoringDeps {
  /** Undefined when the worker booted without DATABASE_URL (dev without a DB). */
  service: Pick<ScoringService, 'processJob'> | undefined;
}

export function createScoringDispatchProcessor(deps: ScoringDeps) {
  return async (payload: JobPayload<'scoring.dispatch'>): Promise<void> => {
    if (!deps.service) {
      throw new UnrecoverableError(
        'scoring.dispatch: scoring service not configured (set DATABASE_URL)'
      );
    }
    const result = await deps.service.processJob(payload.jobId);
    if (!result.ok) {
      const permanent = result.error.detail?.['permanent'] === true;
      const message = `scoring.dispatch ${payload.jobId}: ${result.error.code}`;
      if (permanent) throw new UnrecoverableError(message);
      throw new Error(message);
    }
    console.log(
      `[worker] scoring.dispatch processed ${payload.jobId} (status=${result.value.status})`
    );
  };
}
