/**
 * `report.assemble` processor — the worker half of spec 09's assembly flow
 * (E3): scoring's applyScores enqueued the session id; this hands it to
 * `reportService.assemble`, which loads the scored session, merges the
 * product's uploaded HTML template, persists the `reports` row and drives
 * session/order state (`report_ready` / `reports_ready`).
 *
 * Processors stay thin (03-architecture.md): call the service, map its
 * Result. Error mapping mirrors scoring.ts:
 * - service unavailable / permanent assembly failures (missing template,
 *   unscored session) → `UnrecoverableError` (park in the failed set for
 *   admin reassemble after the data problem is fixed);
 * - anything else (storage/translation infra) → normal throw, retried per
 *   the queue's default backoff.
 *
 * Log/error strings carry ids and error codes only — never respondent data
 * or report content.
 */
import { UnrecoverableError } from 'bullmq';
import type { JobPayload } from '@assessify/domain';
import type { ReportService } from '@assessify/services';

export interface ReportAssemblyDeps {
  /** Undefined when the worker booted without DATABASE_URL or object storage. */
  service: Pick<ReportService, 'assemble'> | undefined;
}

export function createReportAssembleProcessor(deps: ReportAssemblyDeps) {
  return async (payload: JobPayload<'report.assemble'>): Promise<void> => {
    if (!deps.service) {
      throw new UnrecoverableError(
        'report.assemble: report service not configured (set DATABASE_URL and S3_* storage env)'
      );
    }
    const result = await deps.service.assemble(payload.sessionId);
    if (!result.ok) {
      const permanent = result.error.detail?.['permanent'] === true;
      const message = `report.assemble ${payload.sessionId}: ${result.error.code}`;
      if (permanent) throw new UnrecoverableError(message);
      throw new Error(message);
    }
    console.log(
      `[worker] report.assemble processed ${payload.sessionId} (report=${result.value.reportId}, status=${result.value.status})`
    );
  };
}
