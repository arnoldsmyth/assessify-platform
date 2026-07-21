import {
  err,
  isSuperAdmin,
  ok,
  scoreSetSchema,
  systemCallerContext,
  uuidv7,
  type AnswersMap,
  type CallerContext,
  type DomainError,
  type Result,
  type ScoreSet,
  type ScoringAnswers,
  type ScoringConfig,
  type ScoringJob,
  type ScoringJobStatus,
} from '@assessify/domain';
import type {
  JobQueue,
  ScoringAdapter,
  ScoringInput,
  ScoringOutcome,
} from '@assessify/adapters';
import type {
  ProductRepository,
  QuestionnaireVersionRepository,
  RespondentSessionRepository,
  ResponseRepository,
  ScoringJobRepository,
} from '@assessify/repositories';

import type { AuditService } from '../audit';
import type { OrderService } from '../orders';
import {
  createQueueReportAssemblyDispatcher,
  noopReportAssemblyDispatcher,
  type ReportAssemblyDispatcher,
} from '../reports/dispatcher';
import type { ScoringDispatchReceipt, ScoringDispatcher } from './dispatcher';

/**
 * Scoring business logic (E1 — spec 08). Owns the scoring_jobs lifecycle and
 * drives session/order state around it:
 *
 *   submit (C2) → dispatch(sessionId)
 *     → scoring_jobs row (`queued`) + `scoring.dispatch` queue job
 *     → session `awaiting_scores`, order `completion_rule_met`
 *   worker → processJob(jobId)
 *     → build PII-free ScoringInput from the submitted response
 *     → adapter per product `scoring_config.mode`
 *       ├─ sync_result     → applyScores: session `scored`, job `completed`
 *       ├─ accepted_async  → job `awaiting_callback` (E2 callback/pull + watchdog)
 *       └─ failed          → retry w/ backoff up to maxAttempts
 *                            → job `failed`, order `scoring_error` + alert
 *   admin (D7) → retry(caller, jobId): failed → queued, order back to
 *   processing_report, job re-enqueued.
 *
 * Order status is ONLY ever driven through `orderService.transition`
 * (spec 06: services never set `orders.status` directly), and every state
 * change writes an audit event.
 *
 * PII rule (spec 08 hard rule): outbound payloads carry ids, option keys and
 * numbers only. Free-text answers and hidden-flagged answers are stripped;
 * errors and audit detail carry ids/codes, never answer values.
 */

export interface ScoringProcessOutcome {
  jobId: string;
  status: ScoringJobStatus;
}

export interface ScoringApplyReceipt {
  jobId: string;
  sessionId: string;
  status: Extract<ScoringJobStatus, 'completed'>;
}

export interface ScoringService extends ScoringDispatcher {
  /**
   * Create the scoring job for a completed session, move the session to
   * `awaiting_scores`, nudge the order (`completion_rule_met`) and enqueue
   * the worker job. Idempotent: an existing non-failed job is returned as-is.
   */
  dispatch(sessionId: string): Promise<Result<ScoringDispatchReceipt>>;
  /**
   * Worker-only: load the submitted response, call the product's scoring
   * adapter, and apply the outcome. Error results carry `detail.permanent`
   * so the processor can choose between backoff retry and the failed set.
   */
  processJob(jobId: string): Promise<Result<ScoringProcessOutcome>>;
  /**
   * Validate and apply a ScoreSet to a job's session (spec 08 applyScores):
   * session `scored` + `scores`/`scored_at`, job `completed`, audit. Used by
   * the sync path here and by E2's callback/pull retrieval. Idempotent for
   * already-completed jobs.
   */
  applyScores(jobId: string, scores: unknown): Promise<Result<ScoringApplyReceipt>>;
  /**
   * Admin retry (D7, super_admin only): failed → queued, order
   * `retry_scoring` (scoring_error → processing_report), job re-enqueued.
   */
  retry(caller: CallerContext, jobId: string): Promise<Result<ScoringDispatchReceipt>>;
}

/** Adapters keyed by `scoring_config.mode`; wired at composition roots. */
export interface ScoringServiceAdapters {
  sync_internal?: ScoringAdapter;
  async_external?: ScoringAdapter;
}

export interface ScoringServiceDeps {
  scoringJobs: ScoringJobRepository;
  sessions: Pick<RespondentSessionRepository, 'findById' | 'markAwaitingScores' | 'applyScores'>;
  responses: Pick<ResponseRepository, 'findBySessionId'>;
  versions: Pick<QuestionnaireVersionRepository, 'findById'>;
  products: Pick<ProductRepository, 'findById'>;
  orderService: Pick<OrderService, 'transition'>;
  audit: AuditService;
  /** Required for dispatch/retry; processJob never enqueues. */
  queue?: JobQueue;
  adapters?: ScoringServiceAdapters;
  /**
   * Seam through which applyScores triggers `report.assemble` (spec 09 —
   * E3). Defaults to a queue-backed dispatcher when `queue` is present, else
   * a no-op (admin reassemble catches up later).
   */
  reportAssembly?: ReportAssemblyDispatcher;
  now?: () => Date;
  generateId?: () => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Outbound payload (PII filter)
// ---------------------------------------------------------------------------

/**
 * Flatten submitted answers into the engine payload: option keys and numbers
 * only. Free-text answers are dropped (they can contain PII and no engine
 * contract consumes them — spec 08 hard rule); hidden-flagged answers are
 * dropped (spec 07: "scoring adapters decide" — the platform default is to
 * score visible answers only). Exported for tests.
 */
export function buildScoringAnswers(answers: AnswersMap): ScoringAnswers {
  const out: ScoringAnswers = {};
  for (const [key, record] of Object.entries(answers)) {
    if (record.hidden === true) continue;
    if (record.type === 'free_text') continue;
    out[key] = record.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errors — ids and codes only, never answer values or respondent data.
// ---------------------------------------------------------------------------

function notFound(code: string, message: string, id: string, permanent = false): DomainError {
  return {
    code,
    message,
    detail: { id, ...(permanent ? { permanent: true } : {}) },
  };
}

function permanentError(
  code: string,
  message: string,
  detail: Record<string, unknown> = {}
): DomainError {
  return { code, message, detail: { ...detail, permanent: true } };
}

export function createScoringService(deps: ScoringServiceDeps): ScoringService {
  const { scoringJobs, sessions, responses, versions, products, orderService, audit } = deps;
  const adapters = deps.adapters ?? {};
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? uuidv7;
  const systemActor = { kind: 'system' as const, id: 'system' };
  const reportAssembly =
    deps.reportAssembly ??
    (deps.queue ? createQueueReportAssemblyDispatcher(deps.queue) : noopReportAssemblyDispatcher);

  /**
   * Drive an order transition as the system, tolerating races: an
   * `order/illegal_transition` or `order/conflict` means another session or a
   * concurrent worker already moved the order (normal for bulk orders).
   */
  async function nudgeOrder(
    orderId: string,
    event: 'completion_rule_met' | 'scoring_failed',
    errorDetail?: Record<string, unknown>
  ): Promise<Result<null>> {
    const result = await orderService.transition(systemCallerContext(), orderId, {
      event,
      ...(errorDetail ? { errorDetail } : {}),
    });
    if (!result.ok) {
      const tolerated =
        result.error.code === 'order/illegal_transition' || result.error.code === 'order/conflict';
      if (!tolerated) return err(result.error);
    }
    return ok(null);
  }

  /** Terminal failure: park the job, flag the order, audit. */
  async function failPermanently(
    job: ScoringJob,
    orderId: string | null,
    error: string
  ): Promise<Result<never>> {
    await scoringJobs.fail(job.id, error);
    if (orderId) {
      // scoring_error is an admin-alerting state (spec 06): the error queue
      // and retry UI hang off orders.error_detail.
      await nudgeOrder(orderId, 'scoring_failed', {
        scoringJobId: job.id,
        sessionId: job.sessionId,
        error,
      });
    }
    await audit.record(
      systemActor,
      'scoring_job.failed',
      { type: 'scoring_job', id: job.id },
      { sessionId: job.sessionId, ...(orderId ? { orderId } : {}), error, attempts: job.attempts }
    );
    return err(
      permanentError('scoring/failed', 'Scoring failed permanently for this session', {
        jobId: job.id,
        error,
      })
    );
  }

  /** Shared applyScores core (sync path + E2 callback/pull retrieval). */
  async function applyScoresToJob(
    job: ScoringJob,
    scores: ScoreSet
  ): Promise<Result<ScoringApplyReceipt>> {
    const at = now();
    const applied = await sessions.applyScores(job.sessionId, scores, at);
    if (!applied) {
      return err(
        permanentError('scoring/session_not_scorable', 'The session cannot accept scores', {
          jobId: job.id,
          sessionId: job.sessionId,
        })
      );
    }
    const completed = await scoringJobs.complete(job.id, scores, at);
    if (!completed) {
      // Lost the CAS race to a concurrent apply — the scores are on the
      // session either way; report the row's current state idempotently.
      const current = await scoringJobs.findById(job.id);
      if (current?.status === 'completed') {
        return ok({ jobId: job.id, sessionId: job.sessionId, status: 'completed' });
      }
      return err(
        permanentError('scoring/job_conflict', 'The scoring job changed state concurrently', {
          jobId: job.id,
        })
      );
    }
    const audited = await audit.record(
      systemActor,
      'scoring_job.completed',
      { type: 'scoring_job', id: job.id },
      {
        sessionId: job.sessionId,
        mode: job.mode,
        attempts: completed.attempts,
        // Keys only — score values belong to the session record, not the log.
        dimensionKeys: Object.keys(scores.dimensions),
      }
    );
    if (!audited.ok) return err(audited.error);
    // Report assembly (`report.assemble`, spec 09 / E3) fires here. A failed
    // enqueue never rolls back the applied scores — the order simply stays
    // `processing_report` until an admin re-assembles; the failure is audited.
    const dispatched = await reportAssembly.dispatch(job.sessionId);
    if (!dispatched.ok) {
      await audit.record(
        systemActor,
        'report.assembly_dispatch_failed',
        { type: 'respondent_session', id: job.sessionId },
        { jobId: job.id, error: dispatched.error.code }
      );
    }
    return ok({ jobId: job.id, sessionId: job.sessionId, status: 'completed' });
  }

  /** Validate-and-apply by job id (shared by processJob and the E2 seam). */
  async function applyScoresById(
    jobId: string,
    scores: unknown
  ): Promise<Result<ScoringApplyReceipt>> {
    if (!UUID_RE.test(jobId)) {
      return err(notFound('scoring/job_not_found', 'Scoring job not found', jobId, true));
    }
    const job = await scoringJobs.findById(jobId);
    if (!job) {
      return err(notFound('scoring/job_not_found', 'Scoring job not found', jobId, true));
    }
    if (job.status === 'completed') {
      return ok({ jobId, sessionId: job.sessionId, status: 'completed' });
    }
    const parsed = scoreSetSchema.safeParse(scores);
    if (!parsed.success) {
      return err(
        permanentError('scoring/scores_invalid', 'The score document failed validation', {
          jobId,
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        })
      );
    }
    return applyScoresToJob(job, parsed.data);
  }

  return {
    async dispatch(sessionId) {
      if (!UUID_RE.test(sessionId)) {
        return err(notFound('scoring/session_not_found', 'Session not found', sessionId));
      }
      const session = await sessions.findById(sessionId);
      if (!session) {
        return err(notFound('scoring/session_not_found', 'Session not found', sessionId));
      }

      // Idempotency: one live job per session (re-scoring goes through
      // retry/re-score flows, not double dispatch).
      const existing = (await scoringJobs.findBySessionId(sessionId))[0];
      if (existing && existing.status !== 'failed') {
        return ok({ jobId: existing.id, status: existing.status });
      }

      const response = await responses.findBySessionId(sessionId);
      if (!response || response.status !== 'submitted') {
        return err({
          code: 'scoring/response_not_submitted',
          message: 'Scoring requires a submitted response',
          detail: { sessionId },
        });
      }

      const version = await versions.findById(session.questionnaireVersionId);
      if (!version) {
        return err(
          notFound('scoring/version_not_found', 'Questionnaire version not found', sessionId)
        );
      }
      const product = await products.findById(version.productId);
      if (!product) {
        return err(notFound('scoring/product_not_found', 'Product not found', version.productId));
      }

      if (!deps.queue) {
        return err({
          code: 'scoring/queue_unavailable',
          message: 'Scoring service was composed without a job queue',
        });
      }

      const job = await scoringJobs.insert({
        id: generateId(),
        sessionId,
        mode: product.scoringConfig.mode,
        createdAt: now(),
      });

      await sessions.markAwaitingScores(sessionId, now());
      const nudged = await nudgeOrder(session.orderId, 'completion_rule_met');
      if (!nudged.ok) return nudged;

      try {
        await deps.queue.enqueue(
          'scoring.dispatch',
          { jobId: job.id },
          { idempotencyKey: `scoring.dispatch:${job.id}` }
        );
      } catch (cause) {
        // The row exists but nothing will process it — park it for admin retry.
        await scoringJobs.fail(job.id, 'enqueue_failed');
        return err({
          code: 'scoring/enqueue_failed',
          message: 'Failed to enqueue the scoring job',
          detail: {
            jobId: job.id,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        });
      }

      const audited = await audit.record(
        systemActor,
        'scoring_job.created',
        { type: 'scoring_job', id: job.id },
        {
          sessionId,
          orderId: session.orderId,
          productId: product.id,
          mode: product.scoringConfig.mode,
        }
      );
      if (!audited.ok) return err(audited.error);

      return ok({ jobId: job.id, status: job.status });
    },

    async processJob(jobId) {
      if (!UUID_RE.test(jobId)) {
        return err(notFound('scoring/job_not_found', 'Scoring job not found', jobId, true));
      }
      const job = await scoringJobs.findById(jobId);
      if (!job) {
        return err(notFound('scoring/job_not_found', 'Scoring job not found', jobId, true));
      }
      // Idempotent redelivery: settled or handed-off jobs are left untouched.
      if (job.status === 'completed' || job.status === 'awaiting_callback') {
        return ok({ jobId, status: job.status });
      }
      if (job.status === 'failed') {
        return err(
          permanentError('scoring/job_already_failed', 'The scoring job already failed', { jobId })
        );
      }

      const session = await sessions.findById(job.sessionId);
      if (!session) {
        return failPermanently(job, null, 'session_missing');
      }
      const response = await responses.findBySessionId(job.sessionId);
      if (!response || response.status !== 'submitted') {
        return failPermanently(job, session.orderId, 'response_not_submitted');
      }
      const version = await versions.findById(session.questionnaireVersionId);
      if (!version) {
        return failPermanently(job, session.orderId, 'questionnaire_version_missing');
      }
      const product = await products.findById(version.productId);
      if (!product) {
        return failPermanently(job, session.orderId, 'product_missing');
      }
      const config: ScoringConfig = product.scoringConfig;

      const adapter = adapters[config.mode];
      if (!adapter) {
        return failPermanently(job, session.orderId, `adapter_unavailable:${config.mode}`);
      }

      const input: ScoringInput = {
        jobId: job.id,
        sessionId: job.sessionId,
        product: { id: product.id, externalIds: product.externalIds },
        questionnaire: {
          key: version.definition.key,
          version: version.version,
          variant: version.variant,
        },
        answers: buildScoringAnswers(response.answers),
        ...(session.language ? { respondentMeta: { language: session.language } } : {}),
        // callback url/token pair is minted by E2's async wiring; pull
        // retrieval and sync engines never receive one.
        config,
      };

      // Snapshot the (PII-free) outbound payload and count the attempt.
      const dispatched = await scoringJobs.markDispatched(job.id, now(), {
        product: input.product,
        questionnaire: input.questionnaire,
        answers: input.answers,
      });
      if (!dispatched) {
        return err(
          permanentError('scoring/job_conflict', 'The scoring job changed state concurrently', {
            jobId,
          })
        );
      }

      let outcome: ScoringOutcome;
      try {
        outcome = await adapter.score(input);
      } catch (cause) {
        outcome = {
          kind: 'failed' as const,
          retryable: true,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }

      if (outcome.kind === 'sync_result') {
        const applied = await applyScoresById(job.id, outcome.scores);
        if (!applied.ok) return applied;
        return ok({ jobId, status: applied.value.status });
      }

      if (outcome.kind === 'accepted_async') {
        // Callback token hashing is E2's concern; the lifecycle slot exists now.
        const awaiting = await scoringJobs.markAwaitingCallback(job.id, null);
        if (!awaiting) {
          return err(
            permanentError('scoring/job_conflict', 'The scoring job changed state concurrently', {
              jobId,
            })
          );
        }
        const audited = await audit.record(
          systemActor,
          'scoring_job.accepted_async',
          { type: 'scoring_job', id: job.id },
          { sessionId: job.sessionId, retrieval: outcome.retrieval }
        );
        if (!audited.ok) return err(audited.error);
        return ok({ jobId, status: 'awaiting_callback' });
      }

      // failed
      if (outcome.retryable && dispatched.attempts < config.maxAttempts) {
        // Soft failure below the attempt cap: leave the job `dispatched` and
        // let the queue's backoff re-run processJob (spec 08 retry w/ backoff).
        return err({
          code: 'scoring/attempt_failed',
          message: 'The scoring engine failed; the job will be retried',
          detail: {
            jobId,
            attempts: dispatched.attempts,
            maxAttempts: config.maxAttempts,
            error: outcome.error,
          },
        });
      }
      return failPermanently(dispatched, session.orderId, outcome.error);
    },

    applyScores(jobId, scores) {
      return applyScoresById(jobId, scores);
    },

    async retry(caller, jobId) {
      // D7: retry after scoring_error is super_admin only (spec 05 matrix).
      if (!isSuperAdmin(caller)) {
        return err({
          code: 'scoring/forbidden',
          message: 'Only super admins may retry scoring',
          detail: { action: 'retry' },
        });
      }
      if (!UUID_RE.test(jobId)) {
        return err(notFound('scoring/job_not_found', 'Scoring job not found', jobId));
      }
      const job = await scoringJobs.findById(jobId);
      if (!job) {
        return err(notFound('scoring/job_not_found', 'Scoring job not found', jobId));
      }
      const requeued = await scoringJobs.requeue(jobId);
      if (!requeued) {
        return err({
          code: 'scoring/retry_invalid_state',
          message: `Only failed scoring jobs can be retried (job is "${job.status}")`,
          detail: { jobId, status: job.status },
        });
      }

      if (!deps.queue) {
        return err({
          code: 'scoring/queue_unavailable',
          message: 'Scoring service was composed without a job queue',
        });
      }

      const session = await sessions.findById(job.sessionId);
      if (session) {
        // scoring_error → processing_report as the acting admin; tolerate
        // orders another session already moved (bulk orders).
        const transitioned = await orderService.transition(caller, session.orderId, {
          event: 'retry_scoring',
        });
        if (!transitioned.ok && transitioned.error.code !== 'order/illegal_transition') {
          return err(transitioned.error);
        }
      }

      try {
        await deps.queue.enqueue(
          'scoring.dispatch',
          { jobId },
          { idempotencyKey: `scoring.dispatch:retry:${jobId}:${now().getTime()}` }
        );
      } catch (cause) {
        await scoringJobs.fail(jobId, 'enqueue_failed');
        return err({
          code: 'scoring/enqueue_failed',
          message: 'Failed to enqueue the scoring retry',
          detail: {
            jobId,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        });
      }

      const audited = await audit.record(
        { kind: caller.kind, id: caller.id },
        'scoring_job.retried',
        { type: 'scoring_job', id: jobId },
        { sessionId: job.sessionId, previousError: job.error }
      );
      if (!audited.ok) return err(audited.error);

      return ok({ jobId, status: 'queued' });
    },
  };
}
