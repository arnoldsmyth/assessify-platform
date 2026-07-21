import {
  err,
  ok,
  scoringConfigSchema,
  systemCallerContext,
  type CallerContext,
  type Product,
  type QuestionnaireResponse,
  type RespondentAccessSession,
  type Result,
  type ScoringJob,
} from '@assessify/domain';
import type { EnqueuedJob, JobQueue } from '@assessify/adapters';
import { createMemoryScoringAdapter } from '@assessify/adapters/scoring/memory';
import type {
  QuestionnaireVersion,
  RespondentIdentity,
  ScoringJobCreate,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import type { ReportAssemblyDispatcher } from '../reports/dispatcher';
import { buildScoringAnswers, createScoringService } from './scoring-service';

const SESSION_ID = '01890000-0000-7000-8000-00000000aaaa';
const ORDER_ID = '01890000-0000-7000-8000-00000000bbbb';
const PRODUCT_ID = '01890000-0000-7000-8000-00000000cccc';
const VERSION_ID = '01890000-0000-7000-8000-00000000dddd';
const JOB_ID = '01890000-0000-7000-8000-000000000001';
const NOW = new Date('2026-07-20T10:00:00Z');
const ANSWERED_AT = NOW.toISOString();

const superAdmin: CallerContext = {
  kind: 'user',
  id: 'admin-1',
  roles: [{ role: 'super_admin', organizationId: null, productId: null, clientId: null, permissions: {
    products: [], groups: [], canPlaceOrders: false, canViewResults: false, canReleaseReports: false,
  } }],
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeScoringJobs {
  rows = new Map<string, ScoringJob>();
  async insert(input: ScoringJobCreate): Promise<ScoringJob> {
    const job: ScoringJob = {
      id: input.id,
      sessionId: input.sessionId,
      mode: input.mode,
      status: 'queued',
      callbackTokenHash: null,
      requestPayload: null,
      responsePayload: null,
      error: null,
      attempts: 0,
      dispatchedAt: null,
      completedAt: null,
      createdAt: input.createdAt ?? NOW,
    };
    this.rows.set(job.id, job);
    return job;
  }
  async findById(id: string): Promise<ScoringJob | null> {
    return this.rows.get(id) ?? null;
  }
  async findBySessionId(sessionId: string): Promise<ScoringJob[]> {
    return [...this.rows.values()]
      .filter((j) => j.sessionId === sessionId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async findByOrderId(): Promise<ScoringJob[]> {
    return [...this.rows.values()];
  }
  private cas(
    id: string,
    from: readonly ScoringJob['status'][],
    patch: Partial<ScoringJob>
  ): ScoringJob | null {
    const row = this.rows.get(id);
    if (!row || !from.includes(row.status)) return null;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return next;
  }
  async markDispatched(
    id: string,
    at: Date,
    requestPayload: Record<string, unknown>
  ): Promise<ScoringJob | null> {
    const current = this.rows.get(id);
    return this.cas(id, ['queued', 'dispatched'], {
      status: 'dispatched',
      dispatchedAt: at,
      requestPayload,
      attempts: (current?.attempts ?? 0) + 1,
    });
  }
  async markAwaitingCallback(id: string, hash: string | null): Promise<ScoringJob | null> {
    return this.cas(id, ['dispatched'], { status: 'awaiting_callback', callbackTokenHash: hash });
  }
  async complete(
    id: string,
    responsePayload: Record<string, unknown>,
    at: Date
  ): Promise<ScoringJob | null> {
    return this.cas(id, ['dispatched', 'awaiting_callback'], {
      status: 'completed',
      responsePayload,
      completedAt: at,
      error: null,
    });
  }
  async fail(id: string, error: string): Promise<ScoringJob | null> {
    return this.cas(id, ['queued', 'dispatched', 'awaiting_callback'], { status: 'failed', error });
  }
  async requeue(id: string): Promise<ScoringJob | null> {
    return this.cas(id, ['failed'], {
      status: 'queued',
      error: null,
      attempts: 0,
      dispatchedAt: null,
      callbackTokenHash: null,
    });
  }
  async listStuck(): Promise<ScoringJob[]> {
    return [];
  }
  async setExternalRef(
    id: string,
    ref: { provider: string; assessmentId: string }
  ): Promise<ScoringJob | null> {
    const row = this.rows.get(id);
    if (!row || row.status === 'failed') return null;
    const next = {
      ...row,
      requestPayload: { ...(row.requestPayload ?? {}), externalRef: { ...ref } },
    };
    this.rows.set(id, next);
    return next;
  }
  async findByExternalRef(provider: string, assessmentId: string): Promise<ScoringJob | null> {
    const matches = [...this.rows.values()]
      .filter((job) => {
        const ref = job.requestPayload?.['externalRef'] as
          | { provider?: string; assessmentId?: string }
          | undefined;
        return ref?.provider === provider && ref?.assessmentId === assessmentId;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches[0] ?? null;
  }
}

function fakeSession(
  overrides: Partial<RespondentAccessSession> = {}
): RespondentAccessSession {
  return {
    id: SESSION_ID,
    orderId: ORDER_ID,
    respondentId: null,
    token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    pinHash: null,
    status: 'completed',
    isFocal: true,
    questionnaireVersionId: VERSION_ID,
    language: 'en',
    invitedAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

class FakeSessions {
  awaitingScores: string[] = [];
  scores: Record<string, unknown> | null = null;
  constructor(public session: RespondentAccessSession | null = fakeSession()) {}
  async findById(id: string): Promise<RespondentAccessSession | null> {
    return this.session && this.session.id === id ? this.session : null;
  }
  async markAwaitingScores(id: string): Promise<boolean> {
    this.awaitingScores.push(id);
    if (this.session) this.session = { ...this.session, status: 'awaiting_scores' };
    return true;
  }
  async applyScores(_id: string, scores: Record<string, unknown>): Promise<boolean> {
    this.scores = scores;
    if (this.session) this.session = { ...this.session, status: 'scored' };
    return true;
  }
}

function fakeResponse(overrides: Partial<QuestionnaireResponse> = {}): QuestionnaireResponse {
  return {
    id: '01890000-0000-7000-8000-00000000eeee',
    sessionId: SESSION_ID,
    orderId: ORDER_ID,
    productId: PRODUCT_ID,
    questionnaireVersionId: VERSION_ID,
    language: 'en',
    status: 'submitted',
    answers: {
      q1: { type: 'likert', value: 4, answeredAt: ANSWERED_AT },
      q2: { type: 'likert', value: 2, answeredAt: ANSWERED_AT },
      q_hidden: { type: 'likert', value: 5, answeredAt: ANSWERED_AT, hidden: true },
      q_text: { type: 'free_text', value: 'my name is Pat', answeredAt: ANSWERED_AT },
    },
    progress: { currentSectionKey: null, answeredCount: 2, totalCount: 2 },
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fakeVersion(): QuestionnaireVersion {
  return {
    id: VERSION_ID,
    productId: PRODUCT_ID,
    version: 3,
    variant: 'self',
    definition: {
      schemaVersion: 1,
      key: 'test-def',
      titleKey: 't',
      settings: { progressBar: true, allowBack: true },
      sections: [],
    } as unknown as QuestionnaireVersion['definition'],
    status: 'active',
    createdBy: null,
    createdAt: NOW,
  };
}

function fakeProduct(scoringConfig: unknown): Product {
  return {
    id: PRODUCT_ID,
    organizationId: '01890000-0000-7000-8000-0000000000a1',
    slug: 'pro-d',
    name: 'PRO-D',
    status: 'active',
    defaultAccess: true,
    branding: {},
    defaultLanguage: 'en',
    availableLanguages: ['en'],
    externalIds: { proD: 'PD-1' },
    scoringConfig: scoringConfigSchema.parse(scoringConfig),
    notificationDefaults: {},
    reportPageSizeDefault: 'a4',
    retailEnabled: false,
    retailPrice: null,
    retailCurrency: null,
    revenueSplitPct: null,
    royaltyPolicy: null,
    timezone: 'Europe/Dublin',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fakeQueue(): JobQueue & { enqueued: { jobName: string; payload: unknown }[] } {
  const enqueued: { jobName: string; payload: unknown }[] = [];
  return {
    enqueued,
    async enqueue(jobName, payload): Promise<EnqueuedJob> {
      enqueued.push({ jobName, payload });
      return { jobId: `q-${enqueued.length}` };
    },
  };
}

function fakeAudit(): AuditService & { record: ReturnType<typeof vi.fn> } {
  return {
    record: vi.fn(async () =>
      ok({
        id: '01890000-0000-7000-8000-00000000ffff',
        actor: { kind: 'system' as const, id: 'system' },
        action: 'scoring_job.created',
        entityRef: { type: 'scoring_job', id: JOB_ID },
        detail: null,
        createdAt: NOW,
      })
    ),
    listByEntity: vi.fn(async () => ok({ events: [], nextCursor: null })),
  } as unknown as AuditService & { record: ReturnType<typeof vi.fn> };
}

interface BuildOverrides {
  scoringJobs?: FakeScoringJobs;
  sessions?: FakeSessions;
  response?: QuestionnaireResponse | null;
  scoringConfig?: unknown;
  transition?: ReturnType<typeof vi.fn>;
  queue?: ReturnType<typeof fakeQueue> | undefined;
  adapter?: ReturnType<typeof createMemoryScoringAdapter> | undefined;
  respondents?: { findById: (id: string) => Promise<RespondentIdentity | null> };
  reportAssembly?: ReportAssemblyDispatcher;
}

function build(overrides: BuildOverrides = {}) {
  const scoringJobs = overrides.scoringJobs ?? new FakeScoringJobs();
  const sessions = overrides.sessions ?? new FakeSessions();
  const response = overrides.response === undefined ? fakeResponse() : overrides.response;
  const product = fakeProduct(
    overrides.scoringConfig ?? {
      mode: 'sync_internal',
      definition: { dimensions: [{ key: 'drive', questionKeys: ['q1', 'q2'] }] },
    }
  );
  const transition =
    overrides.transition ?? vi.fn(async (): Promise<Result<unknown>> => ok({} as never));
  const queue = 'queue' in overrides ? overrides.queue : fakeQueue();
  const adapter = 'adapter' in overrides ? overrides.adapter : createMemoryScoringAdapter();
  const audit = fakeAudit();

  const service = createScoringService({
    scoringJobs,
    sessions,
    responses: { findBySessionId: async (id) => (id === SESSION_ID ? response : null) },
    versions: { findById: async (id) => (id === VERSION_ID ? fakeVersion() : null) },
    products: { findById: async (id) => (id === PRODUCT_ID ? product : null) },
    orderService: { transition } as never,
    audit,
    queue,
    adapters: adapter ? { [adapter.mode]: adapter } : {},
    ...(overrides.respondents ? { respondents: overrides.respondents } : {}),
    ...(overrides.reportAssembly ? { reportAssembly: overrides.reportAssembly } : {}),
    now: () => NOW,
    generateId: () => JOB_ID,
  });
  return { service, scoringJobs, sessions, transition, queue, adapter, audit };
}

// ---------------------------------------------------------------------------
// buildScoringAnswers (PII filter)
// ---------------------------------------------------------------------------

describe('buildScoringAnswers', () => {
  it('flattens values and strips free-text and hidden answers', () => {
    const answers = buildScoringAnswers(fakeResponse().answers);
    expect(answers).toEqual({ q1: 4, q2: 2 });
  });
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  it('creates the job, moves the session, nudges the order and enqueues', async () => {
    const { service, scoringJobs, sessions, transition, queue, audit } = build();
    const result = await service.dispatch(SESSION_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ jobId: JOB_ID, status: 'queued' });
    expect(scoringJobs.rows.get(JOB_ID)?.mode).toBe('sync_internal');
    expect(sessions.session?.status).toBe('awaiting_scores');
    expect(transition).toHaveBeenCalledWith(systemCallerContext(), ORDER_ID, {
      event: 'completion_rule_met',
    });
    expect(queue?.enqueued).toEqual([
      { jobName: 'scoring.dispatch', payload: { jobId: JOB_ID } },
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'system', id: 'system' },
      'scoring_job.created',
      { type: 'scoring_job', id: JOB_ID },
      expect.objectContaining({ sessionId: SESSION_ID, orderId: ORDER_ID, mode: 'sync_internal' })
    );
  });

  it('is idempotent: an existing live job is returned without a new enqueue', async () => {
    const { service, queue } = build();
    await service.dispatch(SESSION_ID);
    const again = await service.dispatch(SESSION_ID);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.jobId).toBe(JOB_ID);
    expect(queue?.enqueued).toHaveLength(1);
  });

  it('tolerates an order that already left `sent` (bulk orders)', async () => {
    const transition = vi.fn(async () =>
      err({ code: 'order/illegal_transition', message: 'no' })
    );
    const { service } = build({ transition });
    const result = await service.dispatch(SESSION_ID);
    expect(result.ok).toBe(true);
  });

  it('rejects sessions without a submitted response', async () => {
    const { service } = build({ response: fakeResponse({ status: 'draft' }) });
    const result = await service.dispatch(SESSION_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scoring/response_not_submitted');
  });

  it('parks the job when the enqueue fails', async () => {
    const queue = fakeQueue();
    queue.enqueue = async () => {
      throw new Error('valkey down');
    };
    const { service, scoringJobs } = build({ queue });
    const result = await service.dispatch(SESSION_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scoring/enqueue_failed');
    expect(scoringJobs.rows.get(JOB_ID)?.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// processJob
// ---------------------------------------------------------------------------

async function dispatched(overrides: BuildOverrides = {}) {
  const built = build(overrides);
  const result = await built.service.dispatch(SESSION_ID);
  if (!result.ok) throw new Error(`dispatch failed: ${result.error.code}`);
  return built;
}

describe('processJob', () => {
  it('happy path: adapter sync_result → session scored, job completed', async () => {
    const adapter = createMemoryScoringAdapter();
    adapter.queueOutcome({
      kind: 'sync_result',
      scores: { dimensions: { drive: 6 }, bands: { drive: 'high' } },
    });
    const { service, scoringJobs, sessions } = await dispatched({ adapter });

    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ jobId: JOB_ID, status: 'completed' });

    const job = scoringJobs.rows.get(JOB_ID);
    expect(job?.status).toBe('completed');
    expect(job?.attempts).toBe(1);
    expect(job?.responsePayload).toEqual({ dimensions: { drive: 6 }, bands: { drive: 'high' } });
    expect(sessions.session?.status).toBe('scored');
    expect(sessions.scores).toEqual({ dimensions: { drive: 6 }, bands: { drive: 'high' } });
  });

  it('builds a PII-free ScoringInput and snapshots it on the job', async () => {
    const adapter = createMemoryScoringAdapter();
    const { service, scoringJobs } = await dispatched({ adapter });
    await service.processJob(JOB_ID);

    expect(adapter.scored).toHaveLength(1);
    const input = adapter.scored[0]!;
    expect(input.answers).toEqual({ q1: 4, q2: 2 }); // free_text + hidden stripped
    expect(input.product).toEqual({ id: PRODUCT_ID, externalIds: { proD: 'PD-1' } });
    expect(input.questionnaire).toEqual({ key: 'test-def', version: 3, variant: 'self' });
    expect(input.respondentMeta).toEqual({ language: 'en' });
    expect(JSON.stringify(input.answers)).not.toContain('Pat');
    expect(JSON.stringify(scoringJobs.rows.get(JOB_ID)?.requestPayload)).not.toContain('Pat');
  });

  it('accepted_async parks the job awaiting_callback', async () => {
    const adapter = createMemoryScoringAdapter({ mode: 'async_external' });
    adapter.queueOutcome({ kind: 'accepted_async', retrieval: 'pull' });
    const { service, scoringJobs, sessions } = await dispatched({
      adapter,
      scoringConfig: {
        mode: 'async_external',
        retrieval: 'pull',
        endpoint: 'https://engine.example/api',
      },
    });
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('awaiting_callback');
    expect(scoringJobs.rows.get(JOB_ID)?.status).toBe('awaiting_callback');
    // Session stays awaiting_scores until the callback/pull applies scores.
    expect(sessions.session?.status).toBe('awaiting_scores');
  });

  it('retryable failure below maxAttempts leaves the job dispatched for backoff', async () => {
    const adapter = createMemoryScoringAdapter();
    adapter.queueOutcome({ kind: 'failed', retryable: true, error: 'engine_timeout' });
    const { service, scoringJobs, transition } = await dispatched({ adapter });

    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scoring/attempt_failed');
    expect(result.error.detail?.['permanent']).toBeUndefined();
    expect(scoringJobs.rows.get(JOB_ID)?.status).toBe('dispatched');
    // No scoring_failed order transition yet.
    expect(transition).toHaveBeenCalledTimes(1); // only completion_rule_met from dispatch
  });

  it('exhausted retries fail the job and drive the order to scoring_error', async () => {
    const adapter = createMemoryScoringAdapter();
    for (let i = 0; i < 3; i += 1) {
      adapter.queueOutcome({ kind: 'failed', retryable: true, error: 'engine_timeout' });
    }
    const { service, scoringJobs, transition } = await dispatched({ adapter });

    await service.processJob(JOB_ID); // attempt 1
    await service.processJob(JOB_ID); // attempt 2
    const final = await service.processJob(JOB_ID); // attempt 3 = maxAttempts
    expect(final.ok).toBe(false);
    if (final.ok) return;
    expect(final.error.code).toBe('scoring/failed');
    expect(final.error.detail?.['permanent']).toBe(true);
    expect(scoringJobs.rows.get(JOB_ID)?.status).toBe('failed');
    expect(transition).toHaveBeenLastCalledWith(systemCallerContext(), ORDER_ID, {
      event: 'scoring_failed',
      errorDetail: expect.objectContaining({ scoringJobId: JOB_ID, sessionId: SESSION_ID }),
    });
  });

  it('non-retryable failure parks immediately regardless of attempts left', async () => {
    const adapter = createMemoryScoringAdapter();
    adapter.queueOutcome({ kind: 'failed', retryable: false, error: 'bad_definition' });
    const { service, scoringJobs } = await dispatched({ adapter });
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['permanent']).toBe(true);
    expect(scoringJobs.rows.get(JOB_ID)?.status).toBe('failed');
    expect(scoringJobs.rows.get(JOB_ID)?.error).toBe('bad_definition');
  });

  it('a thrown adapter error counts as a retryable attempt', async () => {
    const adapter = createMemoryScoringAdapter();
    adapter.failWith(new Error('socket hang up'));
    const { service, scoringJobs } = await dispatched({ adapter });
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scoring/attempt_failed');
    expect(scoringJobs.rows.get(JOB_ID)?.status).toBe('dispatched');
  });

  it('an invalid ScoreSet from the engine is a permanent validation failure', async () => {
    const adapter = createMemoryScoringAdapter();
    adapter.queueOutcome({
      kind: 'sync_result',
      scores: { dimensions: { drive: Number.NaN } } as never,
    });
    const { service } = await dispatched({ adapter });
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scoring/scores_invalid');
    expect(result.error.detail?.['permanent']).toBe(true);
  });

  it('fails permanently when no adapter serves the configured mode', async () => {
    const { service, scoringJobs } = await dispatched({ adapter: undefined });
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail?.['permanent']).toBe(true);
    expect(scoringJobs.rows.get(JOB_ID)?.error).toBe('adapter_unavailable:sync_internal');
  });

  it('is idempotent for completed jobs', async () => {
    const adapter = createMemoryScoringAdapter();
    adapter.queueOutcome({ kind: 'sync_result', scores: { dimensions: { drive: 6 } } });
    const { service } = await dispatched({ adapter });
    await service.processJob(JOB_ID);
    const again = await service.processJob(JOB_ID);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.status).toBe('completed');
    expect(adapter.scored).toHaveLength(1); // engine not called twice
  });

  it('reports unknown jobs as permanent failures', async () => {
    const { service } = build();
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scoring/job_not_found');
    expect(result.error.detail?.['permanent']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyScores (E2 callback/pull seam)
// ---------------------------------------------------------------------------

describe('applyScores', () => {
  it('applies a valid ScoreSet to an awaiting_callback job', async () => {
    const adapter = createMemoryScoringAdapter({ mode: 'async_external' });
    adapter.queueOutcome({ kind: 'accepted_async', retrieval: 'callback' });
    const { service, scoringJobs, sessions } = await dispatched({
      adapter,
      scoringConfig: { mode: 'async_external', endpoint: 'https://engine.example/api' },
    });
    await service.processJob(JOB_ID);

    const result = await service.applyScores(JOB_ID, { dimensions: { drive: 9 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ jobId: JOB_ID, sessionId: SESSION_ID, status: 'completed' });
    expect(scoringJobs.rows.get(JOB_ID)?.status).toBe('completed');
    expect(sessions.session?.status).toBe('scored');
  });

  it('rejects malformed score documents', async () => {
    const { service } = await dispatched({});
    const result = await service.applyScores(JOB_ID, { nope: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scoring/scores_invalid');
  });

  it('is an idempotent no-op for completed jobs (callback replays)', async () => {
    const adapter = createMemoryScoringAdapter();
    adapter.queueOutcome({ kind: 'sync_result', scores: { dimensions: { drive: 6 } } });
    const { service, sessions } = await dispatched({ adapter });
    await service.processJob(JOB_ID);
    const replay = await service.applyScores(JOB_ID, { dimensions: { drive: 999 } });
    expect(replay.ok).toBe(true);
    expect(sessions.scores).toEqual({ dimensions: { drive: 6 } }); // untouched
  });

  it('enqueues report.assemble for the session once scores are applied (E3 hook)', async () => {
    const adapter = createMemoryScoringAdapter();
    adapter.queueOutcome({ kind: 'sync_result', scores: { dimensions: { drive: 6 } } });
    const { service, queue } = await dispatched({ adapter });

    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(true);
    expect(queue?.enqueued.at(-1)).toEqual({
      jobName: 'report.assemble',
      payload: { sessionId: SESSION_ID },
    });
  });

  it('a failed report.assemble enqueue never fails the score application', async () => {
    const adapter = createMemoryScoringAdapter();
    adapter.queueOutcome({ kind: 'sync_result', scores: { dimensions: { drive: 6 } } });
    const { service, sessions, audit } = await dispatched({
      adapter,
      reportAssembly: {
        dispatch: async () => err({ code: 'report/assembly_enqueue_failed', message: 'boom' }),
      },
    });

    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(true);
    expect(sessions.session?.status).toBe('scored');
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'system', id: 'system' },
      'report.assembly_dispatch_failed',
      { type: 'respondent_session', id: SESSION_ID },
      expect.objectContaining({ error: 'report/assembly_enqueue_failed' })
    );
  });
});

// ---------------------------------------------------------------------------
// External providers (E2): respondent identity + engine-side references
// ---------------------------------------------------------------------------

const RESPONDENT_ID = '01890000-0000-7000-8000-00000000cafe';
const ASSESSMENT_ID = '01HZXKQ8W9GYV2M4T6R8PLGSCB';
const EXTERNAL_REF = { provider: 'prologic', assessmentId: ASSESSMENT_ID };

const prologicConfig = {
  mode: 'async_external',
  provider: 'prologic',
  accessCode: 'ac_test123',
  scopes: ['mcs'],
  toolMap: { person: { q1: 1, q2: 2 } },
};

function respondentRow(overrides: Partial<RespondentIdentity> = {}): RespondentIdentity {
  return {
    id: RESPONDENT_ID,
    email: 'jane@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    language: 'en',
    ...overrides,
  };
}

function externalBuild(overrides: BuildOverrides = {}) {
  return {
    adapter: createMemoryScoringAdapter({ mode: 'async_external' }),
    sessions: new FakeSessions(fakeSession({ respondentId: RESPONDENT_ID })),
    scoringConfig: prologicConfig,
    respondents: { findById: async (id: string) => (id === RESPONDENT_ID ? respondentRow() : null) },
    ...overrides,
  };
}

describe('processJob — external provider identity', () => {
  it('loads respondent identity onto the input; the snapshot stays PII-free', async () => {
    const overrides = externalBuild();
    overrides.adapter.queueOutcome({
      kind: 'sync_result',
      scores: { dimensions: { 'mcs.m.drive': 72.5 } },
      externalRef: EXTERNAL_REF,
    });
    const { service, scoringJobs } = await dispatched(overrides);
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(true);

    const input = overrides.adapter.scored[0]!;
    // external_id contract: respondents.id — the stable royalty anchor.
    expect(input.respondent).toEqual({
      id: RESPONDENT_ID,
      firstname: 'Jane',
      lastname: 'Doe',
      email: 'jane@example.com',
    });
    // Identity is for the adapter call ONLY — never persisted on the job.
    const snapshot = JSON.stringify(scoringJobs.rows.get(JOB_ID)?.requestPayload);
    expect(snapshot).not.toContain('Jane');
    expect(snapshot).not.toContain('jane@example.com');
  });

  it('fails permanently when the session has no respondent', async () => {
    const overrides = externalBuild({ sessions: new FakeSessions(fakeSession()) });
    const { service, scoringJobs } = await dispatched(overrides);
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(false);
    expect(scoringJobs.rows.get(JOB_ID)?.error).toBe('respondent_identity_missing:session');
    expect(overrides.adapter.scored).toHaveLength(0);
  });

  it('fails permanently when identity fields were PII-deleted (names only, no values)', async () => {
    const overrides = externalBuild({
      respondents: { findById: async () => respondentRow({ email: null }) },
    });
    const { service, scoringJobs } = await dispatched(overrides);
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(false);
    expect(scoringJobs.rows.get(JOB_ID)?.error).toBe('respondent_identity_missing:fields');
  });

  it('fails permanently when composed without a respondents repository', async () => {
    const overrides = externalBuild();
    delete (overrides as { respondents?: unknown }).respondents;
    const { service, scoringJobs } = await dispatched(overrides);
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(false);
    expect(scoringJobs.rows.get(JOB_ID)?.error).toBe('respondent_repository_unavailable');
  });

  it('persists the outcome externalRef on the job — including for retryable failures', async () => {
    const overrides = externalBuild();
    overrides.adapter.queueOutcome({
      kind: 'failed',
      retryable: true,
      error: 'prologic_score_http_500',
      externalRef: EXTERNAL_REF,
    });
    const { service, scoringJobs } = await dispatched(overrides);
    const result = await service.processJob(JOB_ID);
    expect(result.ok).toBe(false);
    expect(scoringJobs.rows.get(JOB_ID)?.requestPayload?.['externalRef']).toEqual(EXTERNAL_REF);
    expect(scoringJobs.rows.get(JOB_ID)?.status).toBe('dispatched'); // still retryable
  });
});

// ---------------------------------------------------------------------------
// applyExternalScores (E2 webhook seam)
// ---------------------------------------------------------------------------

describe('applyExternalScores', () => {
  async function scoredExternally() {
    const overrides = externalBuild();
    overrides.adapter.queueOutcome({
      kind: 'failed',
      retryable: true,
      error: 'prologic_score_http_500', // engine scored, our read failed
      externalRef: EXTERNAL_REF,
    });
    const built = await dispatched(overrides);
    await built.service.processJob(JOB_ID);
    return built;
  }

  it('resolves the job by engine reference and applies the scores', async () => {
    const { service, scoringJobs, sessions } = await scoredExternally();
    const result = await service.applyExternalScores(EXTERNAL_REF, {
      dimensions: { 'mcs.m.drive': 72.5 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ jobId: JOB_ID, sessionId: SESSION_ID, status: 'completed' });
    expect(scoringJobs.rows.get(JOB_ID)?.status).toBe('completed');
    expect(sessions.session?.status).toBe('scored');
  });

  it('returns external_ref_unknown (non-permanent) for unmatched references', async () => {
    const { service } = await scoredExternally();
    const result = await service.applyExternalScores(
      { provider: 'prologic', assessmentId: 'unknown' },
      { dimensions: {} }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scoring/external_ref_unknown');
    expect(result.error.detail?.['permanent']).toBeUndefined(); // webhook redelivery may win
  });

  it('is replay-tolerant: a second webhook delivery is a no-op', async () => {
    const { service, sessions } = await scoredExternally();
    await service.applyExternalScores(EXTERNAL_REF, { dimensions: { 'mcs.m.drive': 72.5 } });
    const replay = await service.applyExternalScores(EXTERNAL_REF, {
      dimensions: { 'mcs.m.drive': 1 },
    });
    expect(replay.ok).toBe(true);
    expect(sessions.scores).toEqual({ dimensions: { 'mcs.m.drive': 72.5 } }); // untouched
  });
});

// ---------------------------------------------------------------------------
// retry (D7 admin retry)
// ---------------------------------------------------------------------------

describe('retry', () => {
  async function failedJob() {
    const adapter = createMemoryScoringAdapter();
    adapter.queueOutcome({ kind: 'failed', retryable: false, error: 'bad_definition' });
    const built = await dispatched({ adapter });
    await built.service.processJob(JOB_ID);
    expect(built.scoringJobs.rows.get(JOB_ID)?.status).toBe('failed');
    return built;
  }

  it('requeues a failed job, re-enqueues and retries the order', async () => {
    const { service, scoringJobs, transition, queue, audit } = await failedJob();
    const result = await service.retry(superAdmin, JOB_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ jobId: JOB_ID, status: 'queued' });
    const job = scoringJobs.rows.get(JOB_ID);
    expect(job?.status).toBe('queued');
    expect(job?.attempts).toBe(0);
    expect(job?.error).toBeNull();
    expect(transition).toHaveBeenLastCalledWith(superAdmin, ORDER_ID, {
      event: 'retry_scoring',
    });
    expect(queue?.enqueued.at(-1)).toEqual({
      jobName: 'scoring.dispatch',
      payload: { jobId: JOB_ID },
    });
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: 'admin-1' },
      'scoring_job.retried',
      { type: 'scoring_job', id: JOB_ID },
      expect.objectContaining({ sessionId: SESSION_ID, previousError: 'bad_definition' })
    );
  });

  it('is super_admin only', async () => {
    const { service } = await failedJob();
    const result = await service.retry(systemCallerContext(), JOB_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scoring/forbidden');
  });

  it('rejects jobs that are not failed', async () => {
    const { service } = await dispatched({});
    const result = await service.retry(superAdmin, JOB_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('scoring/retry_invalid_state');
  });
});
