import { err, ok, type Result } from '@assessify/domain';
import type { JobQueue } from '@assessify/adapters';

/**
 * Narrow port through which the scoring service (E1) triggers report
 * assembly when `applyScores` completes — the scoring service never sees
 * assembly logic, only this seam (spec 09 flow: "report.assemble fired by
 * applyScores"; same pattern as E1's ScoringDispatcher).
 */

export interface ReportAssemblyDispatchReceipt {
  sessionId: string;
}

export interface ReportAssemblyDispatcher {
  /**
   * Enqueue `report.assemble` for a scored session. `null` only from the
   * no-op dispatcher.
   */
  dispatch(sessionId: string): Promise<Result<ReportAssemblyDispatchReceipt | null>>;
}

/**
 * Default when a composition root has no queue: scoring completes, nothing
 * is assembled. Admin `reassemble` can always catch up later because scores
 * and templates are immutable.
 */
export const noopReportAssemblyDispatcher: ReportAssemblyDispatcher = {
  async dispatch(): Promise<Result<null>> {
    return ok(null);
  },
};

/** Queue-backed dispatcher; idempotent per session (dedupe on the session id). */
export function createQueueReportAssemblyDispatcher(
  queue: JobQueue
): ReportAssemblyDispatcher {
  return {
    async dispatch(sessionId) {
      try {
        await queue.enqueue(
          'report.assemble',
          { sessionId },
          { idempotencyKey: `report.assemble:${sessionId}` }
        );
      } catch (cause) {
        return err({
          code: 'report/assembly_enqueue_failed',
          message: 'Failed to enqueue report assembly',
          detail: {
            sessionId,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        });
      }
      return ok({ sessionId });
    },
  };
}
