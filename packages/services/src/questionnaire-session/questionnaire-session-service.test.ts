import {
  err,
  ok,
  type AnswerRecord,
  type AnswersPatch,
  type QuestionnaireResponse,
  type RespondentAccessSession,
  type ResponseProgress,
  type Result,
} from '@assessify/domain';
import {
  questionnaireDefinitionSchema,
  type QuestionnaireDefinitionInput,
} from '@assessify/questionnaire-schema';
import type {
  QuestionnaireVersion,
  QuestionnaireVersionRepository,
  RespondentSessionRepository,
  ResponseRepository,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import type { ScoringDispatcher } from '../scoring/dispatcher';
import { createQuestionnaireSessionService } from './questionnaire-session-service';
import type { VisibilityEvaluator } from './visibility';

const SESSION_ID = '01890000-0000-7000-8000-00000000aaaa';
const ORDER_ID = '01890000-0000-7000-8000-00000000bbbb';
const PRODUCT_ID = '01890000-0000-7000-8000-00000000cccc';
const VERSION_ID = '01890000-0000-7000-8000-00000000dddd';
const TOKEN = 'valid-session-token';
const NOW = new Date('2026-07-20T10:00:00Z');

// ---------------------------------------------------------------------------
// Definition fixture: covers every answerable type + a content item
// ---------------------------------------------------------------------------

const definitionInput: QuestionnaireDefinitionInput = {
  schemaVersion: 1,
  key: 'test-def',
  titleKey: 'test.title',
  settings: { progressBar: true, allowBack: true },
  sections: [
    {
      key: 'intro',
      titleKey: 'test.intro.title',
      questions: [
        { key: 'welcome', type: 'content', textKey: 't.w', bodyKey: 't.wb', required: false },
        {
          key: 'q_likert',
          type: 'likert',
          textKey: 't.l',
          scale: { min: 1, max: 5, labelKeys: { '1': 't.lo', '5': 't.hi' }, presentation: 'radio' },
        },
        {
          key: 'q_choice',
          type: 'multiple_choice',
          textKey: 't.c',
          multi: true,
          minSelections: 2,
          maxSelections: 3,
          options: [
            { key: 'a', labelKey: 't.a' },
            { key: 'b', labelKey: 't.b' },
            { key: 'c', labelKey: 't.c1' },
            { key: 'd', labelKey: 't.d' },
          ],
        },
      ],
    },
    {
      key: 'main',
      titleKey: 'test.main.title',
      questions: [
        {
          key: 'q_matrix',
          type: 'matrix',
          textKey: 't.m',
          rows: [
            { key: 'r1', labelKey: 't.r1' },
            { key: 'r2', labelKey: 't.r2' },
          ],
          scale: { min: 1, max: 4, labelKeys: {} },
        },
        {
          key: 'q_rank',
          type: 'ranking',
          textKey: 't.rk',
          options: [
            { key: 'x', labelKey: 't.x' },
            { key: 'y', labelKey: 't.y' },
            { key: 'z', labelKey: 't.z' },
          ],
        },
        {
          key: 'q_text',
          type: 'free_text',
          textKey: 't.ft',
          multiline: true,
          minWords: 3,
          required: false,
        },
        {
          key: 'q_ips',
          type: 'ipsative_most_least',
          textKey: 't.ip',
          items: [
            { key: 'i1', labelKey: 't.i1' },
            { key: 'i2', labelKey: 't.i2' },
            { key: 'i3', labelKey: 't.i3' },
          ],
        },
      ],
    },
  ],
};
const definition = questionnaireDefinitionSchema.parse(definitionInput);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeSession(overrides: Partial<RespondentAccessSession> = {}): RespondentAccessSession {
  return {
    id: SESSION_ID,
    orderId: ORDER_ID,
    respondentId: null,
    token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    pinHash: 'hash',
    status: 'invited',
    isFocal: true,
    questionnaireVersionId: VERSION_ID,
    language: 'en',
    invitedAt: NOW,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

class FakeSessions implements RespondentSessionRepository {
  started: Date | null = null;
  completed: Date | null = null;
  constructor(public session: RespondentAccessSession | null = fakeSession()) {}
  async findByToken(): Promise<RespondentAccessSession | null> {
    return this.session;
  }
  async findById(id: string): Promise<RespondentAccessSession | null> {
    return this.session && this.session.id === id ? this.session : null;
  }
  async markStarted(_id: string, at: Date): Promise<void> {
    this.started = at;
    if (this.session) this.session = { ...this.session, status: 'started', startedAt: at };
  }
  async markCompleted(_id: string, at: Date): Promise<void> {
    this.completed = at;
    if (this.session) this.session = { ...this.session, status: 'completed', completedAt: at };
  }
  async markAwaitingScores(): Promise<boolean> {
    if (this.session?.status !== 'completed') return false;
    this.session = { ...this.session, status: 'awaiting_scores' };
    return true;
  }
  async applyScores(): Promise<boolean> {
    if (!this.session) return false;
    this.session = { ...this.session, status: 'scored' };
    return true;
  }
}

function fakeVersions(def: unknown = definition): QuestionnaireVersionRepository {
  const version: QuestionnaireVersion = {
    id: VERSION_ID,
    productId: PRODUCT_ID,
    version: 1,
    variant: 'self',
    definition: def as QuestionnaireVersion['definition'],
    status: 'active',
    createdBy: null,
    createdAt: NOW,
  };
  return {
    findById: async (id) => (id === VERSION_ID ? version : null),
    findActive: async () => version,
    listByProduct: async () => [version],
    maxVersion: async () => 1,
    insert: async (v) => v,
    updateStatus: async () => version,
  };
}

/** In-memory ResponseRepository honouring the draft-only write guards. */
class FakeResponses implements ResponseRepository {
  rows = new Map<string, QuestionnaireResponse>();
  async findBySessionId(sessionId: string): Promise<QuestionnaireResponse | null> {
    return this.rows.get(sessionId) ?? null;
  }
  async getOrCreate(input: {
    id: string;
    sessionId: string;
    orderId: string;
    productId: string;
    questionnaireVersionId: string;
    language?: string | null;
    startedAt?: Date;
  }): Promise<QuestionnaireResponse> {
    const existing = this.rows.get(input.sessionId);
    if (existing) return existing;
    const row: QuestionnaireResponse = {
      id: input.id,
      sessionId: input.sessionId,
      orderId: input.orderId,
      productId: input.productId,
      questionnaireVersionId: input.questionnaireVersionId,
      language: input.language ?? null,
      status: 'draft',
      answers: {},
      progress: { currentSectionKey: null, answeredCount: 0, totalCount: 0 },
      startedAt: input.startedAt ?? NOW,
      completedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.rows.set(input.sessionId, row);
    return row;
  }
  async patchAnswers(
    sessionId: string,
    patch: AnswersPatch
  ): Promise<QuestionnaireResponse | null> {
    const row = this.rows.get(sessionId);
    if (!row || row.status !== 'draft') return null;
    const next = { ...row, answers: { ...row.answers, ...patch }, updatedAt: new Date() };
    this.rows.set(sessionId, next);
    return next;
  }
  async updateProgress(
    sessionId: string,
    progress: ResponseProgress
  ): Promise<QuestionnaireResponse | null> {
    const row = this.rows.get(sessionId);
    if (!row || row.status !== 'draft') return null;
    const next = { ...row, progress, updatedAt: new Date() };
    this.rows.set(sessionId, next);
    return next;
  }
  async markSubmitted(
    sessionId: string,
    completedAt: Date = new Date()
  ): Promise<QuestionnaireResponse | null> {
    const row = this.rows.get(sessionId);
    if (!row || row.status !== 'draft') return null;
    const next: QuestionnaireResponse = {
      ...row,
      status: 'submitted',
      completedAt,
      updatedAt: completedAt,
    };
    this.rows.set(sessionId, next);
    return next;
  }
}

function fakeAudit(): AuditService & { record: ReturnType<typeof vi.fn> } {
  return {
    record: vi.fn(async () =>
      ok({
        id: '01890000-0000-7000-8000-00000000eeee',
        actor: { kind: 'respondent' as const, id: SESSION_ID },
        action: 'questionnaire_response.submitted',
        entityRef: { type: 'questionnaire_response', id: VERSION_ID },
        detail: undefined,
        at: NOW,
      })
    ),
    listByEntity: vi.fn(async () => ok({ events: [], nextCursor: null })),
  } as unknown as AuditService & { record: ReturnType<typeof vi.fn> };
}

const access = {
  validateSessionToken: async (token: unknown): Promise<Result<{ sessionId: string; exp: number }>> =>
    token === TOKEN
      ? ok({ sessionId: SESSION_ID, exp: NOW.getTime() + 60_000 })
      : err({ code: 'respondent_access/session_invalid', message: 'invalid' }),
};

function build(overrides: {
  sessions?: FakeSessions;
  responses?: FakeResponses;
  versions?: QuestionnaireVersionRepository;
  audit?: ReturnType<typeof fakeAudit>;
  visibility?: VisibilityEvaluator;
  scoring?: ScoringDispatcher;
} = {}) {
  const sessions = overrides.sessions ?? new FakeSessions();
  const responses = overrides.responses ?? new FakeResponses();
  const audit = overrides.audit ?? fakeAudit();
  const service = createQuestionnaireSessionService({
    access,
    sessions,
    versions: overrides.versions ?? fakeVersions(),
    responses,
    audit,
    visibility: overrides.visibility,
    scoring: overrides.scoring,
    now: () => NOW,
    newId: () => '01890000-0000-7000-8000-00000000ffff',
  });
  return { service, sessions, responses, audit };
}

function record(partial: Partial<AnswerRecord> & Pick<AnswerRecord, 'type' | 'value'>): AnswerRecord {
  return { answeredAt: NOW.toISOString(), ...partial } as AnswerRecord;
}

/** All required questions answered (q_text is optional). */
function completeAnswers(): AnswersPatch {
  return {
    q_likert: record({ type: 'likert', value: 4 }),
    q_choice: record({ type: 'multiple_choice', value: ['a', 'b'] }),
    q_matrix: record({ type: 'matrix', value: { r1: 2, r2: 3 } }),
    q_rank: record({ type: 'ranking', value: ['y', 'x', 'z'] }),
    q_ips: record({ type: 'ipsative_most_least', value: { most: 'i1', least: 'i3' } }),
  };
}

// ---------------------------------------------------------------------------
// loadState
// ---------------------------------------------------------------------------

describe('loadState', () => {
  it('creates the draft response on first load and starts the session', async () => {
    const { service, sessions, responses } = build();
    const result = await service.loadState(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('draft');
    expect(result.value.resumeSectionIndex).toBe(0);
    // 5 required answerable questions (welcome=content, q_text optional)
    expect(result.value.progress).toEqual({
      currentSectionKey: null,
      answeredCount: 0,
      totalCount: 5,
    });
    expect(sessions.started).toEqual(NOW);
    expect(responses.rows.get(SESSION_ID)?.status).toBe('draft');
  });

  it('resumes at the saved section with recomputed progress', async () => {
    const responses = new FakeResponses();
    await responses.getOrCreate({
      id: '01890000-0000-7000-8000-000000000001',
      sessionId: SESSION_ID,
      orderId: ORDER_ID,
      productId: PRODUCT_ID,
      questionnaireVersionId: VERSION_ID,
    });
    await responses.patchAnswers(SESSION_ID, {
      q_likert: record({ type: 'likert', value: 2 }),
    });
    await responses.updateProgress(SESSION_ID, {
      currentSectionKey: 'main',
      answeredCount: 99, // stale on purpose — must be recomputed
      totalCount: 99,
    });
    const { service } = build({ responses, sessions: new FakeSessions(fakeSession({ status: 'started' })) });
    const result = await service.loadState(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resumeSectionIndex).toBe(1);
    expect(result.value.progress).toEqual({
      currentSectionKey: 'main',
      answeredCount: 1,
      totalCount: 5,
    });
    expect(result.value.answers.q_likert?.value).toBe(2);
  });

  it('passes access errors through untouched', async () => {
    const { service } = build();
    const result = await service.loadState('bogus');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('respondent_access/session_invalid');
  });

  it('reports an invalid stored definition without leaking detail', async () => {
    const { service } = build({ versions: fakeVersions({ nope: true }) });
    const result = await service.loadState(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('questionnaire/definition_invalid');
  });

  it('returns submitted state (with completedAt) after submit', async () => {
    const { service } = build();
    await service.loadState(TOKEN);
    await service.saveAnswers(TOKEN, completeAnswers());
    await service.submit(TOKEN);
    const result = await service.loadState(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('submitted');
    expect(result.value.completedAt).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// saveAnswers
// ---------------------------------------------------------------------------

describe('saveAnswers', () => {
  async function started() {
    const built = build();
    await built.service.loadState(TOKEN);
    return built;
  }

  it('accepts valid answers and recomputes progress', async () => {
    const { service, responses } = await started();
    const result = await service.saveAnswers(TOKEN, {
      q_likert: record({ type: 'likert', value: 5 }),
      q_choice: record({ type: 'multiple_choice', value: ['a', 'c'] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.savedKeys.sort()).toEqual(['q_choice', 'q_likert']);
    expect(result.value.progress.answeredCount).toBe(2);
    expect(result.value.progress.totalCount).toBe(5);
    expect(responses.rows.get(SESSION_ID)?.answers.q_likert?.value).toBe(5);
  });

  it('rejects a record for a question key not in the definition', async () => {
    const { service, responses } = await started();
    const result = await service.saveAnswers(TOKEN, {
      not_a_question: record({ type: 'likert', value: 3 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('questionnaire/answers_invalid');
    expect(result.error.detail).toEqual({ issues: { not_a_question: ['unknown_question'] } });
    expect(responses.rows.get(SESSION_ID)?.answers).toEqual({});
  });

  it('rejects a record whose type does not match the question', async () => {
    const { service } = await started();
    const result = await service.saveAnswers(TOKEN, {
      q_likert: record({ type: 'free_text', value: 'nope' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toEqual({ issues: { q_likert: ['type_mismatch'] } });
  });

  it('rejects out-of-scale, unknown-option, over-cap and non-permutation values', async () => {
    const { service } = await started();
    const result = await service.saveAnswers(TOKEN, {
      q_likert: record({ type: 'likert', value: 9 }),
      q_choice: record({ type: 'multiple_choice', value: ['a', 'zzz', 'b', 'c', 'd'] }),
      q_rank: record({ type: 'ranking', value: ['x', 'y'] }),
      q_matrix: record({ type: 'matrix', value: { r1: 2, bogus: 1 } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issues = (result.error.detail as { issues: Record<string, string[]> }).issues;
    expect(issues.q_likert).toEqual(['value_out_of_scale']);
    expect(issues.q_choice).toEqual(expect.arrayContaining(['unknown_option', 'too_many_selections']));
    expect(issues.q_rank).toEqual(['not_a_permutation_of_options']);
    expect(issues.q_matrix).toEqual(['unknown_row']);
  });

  it('rejects answering a content item', async () => {
    const { service } = await started();
    const result = await service.saveAnswers(TOKEN, {
      welcome: record({ type: 'free_text', value: 'hi' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toEqual({ issues: { welcome: ['content_not_answerable'] } });
  });

  it('rejects a malformed patch shape', async () => {
    const { service } = await started();
    const result = await service.saveAnswers(TOKEN, { q_likert: { type: 'likert' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('questionnaire/answers_invalid');
  });

  it('refuses writes once submitted (immutability)', async () => {
    const { service } = await started();
    await service.saveAnswers(TOKEN, completeAnswers());
    await service.submit(TOKEN);
    const result = await service.saveAnswers(TOKEN, {
      q_likert: record({ type: 'likert', value: 1 }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('questionnaire/already_submitted');
  });
});

// ---------------------------------------------------------------------------
// savePosition
// ---------------------------------------------------------------------------

describe('savePosition', () => {
  it('stores the current section for resume', async () => {
    const { service } = build();
    await service.loadState(TOKEN);
    const result = await service.savePosition(TOKEN, 'main');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currentSectionKey).toBe('main');
    const state = await service.loadState(TOKEN);
    if (!state.ok) throw new Error('expected ok');
    expect(state.value.resumeSectionIndex).toBe(1);
  });

  it('rejects unknown sections', async () => {
    const { service } = build();
    await service.loadState(TOKEN);
    const result = await service.savePosition(TOKEN, 'nope');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('questionnaire/section_invalid');
  });
});

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

describe('submit', () => {
  it('blocks submit while required questions are missing', async () => {
    const { service, responses } = build();
    await service.loadState(TOKEN);
    await service.saveAnswers(TOKEN, {
      q_likert: record({ type: 'likert', value: 3 }),
    });
    const result = await service.submit(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('questionnaire/incomplete');
    expect((result.error.detail as { missing: string[] }).missing.sort()).toEqual([
      'q_choice',
      'q_ips',
      'q_matrix',
      'q_rank',
    ]);
    expect(responses.rows.get(SESSION_ID)?.status).toBe('draft');
  });

  it('blocks submit on completeness violations of answered questions', async () => {
    const { service } = build();
    await service.loadState(TOKEN);
    await service.saveAnswers(TOKEN, {
      ...completeAnswers(),
      q_choice: record({ type: 'multiple_choice', value: ['a'] }), // below minSelections=2
      q_matrix: record({ type: 'matrix', value: { r1: 2 } }), // r2 missing
      q_text: record({ type: 'free_text', value: 'too short' }), // 2 words < minWords=3
    });
    const result = await service.submit(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const detail = result.error.detail as { missing: string[]; invalid: Record<string, string[]> };
    expect(detail.missing).toEqual([]);
    expect(detail.invalid).toEqual({
      q_choice: ['too_few_selections'],
      q_matrix: ['missing_rows'],
      q_text: ['too_few_words'],
    });
  });

  it('submits, completes the session and writes an audit event', async () => {
    const { service, sessions, responses, audit } = build();
    await service.loadState(TOKEN);
    await service.saveAnswers(TOKEN, completeAnswers());
    const result = await service.submit(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.completedAt).toBe(NOW.toISOString());
    expect(responses.rows.get(SESSION_ID)?.status).toBe('submitted');
    expect(sessions.completed).toEqual(NOW);
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'respondent', id: SESSION_ID },
      'questionnaire_response.submitted',
      { type: 'questionnaire_response', id: '01890000-0000-7000-8000-00000000ffff' },
      expect.objectContaining({ sessionId: SESSION_ID, questionnaireVersionId: VERSION_ID })
    );
  });

  it('is refused a second time', async () => {
    const { service } = build();
    await service.loadState(TOKEN);
    await service.saveAnswers(TOKEN, completeAnswers());
    await service.submit(TOKEN);
    const result = await service.submit(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('questionnaire/already_submitted');
  });

  // E1 seam: submit → scoring dispatch (spec 08 flow).
  it('triggers scoring dispatch with the session id after completing', async () => {
    const dispatch = vi.fn(async () => ok({ jobId: 'job-1', status: 'queued' as const }));
    const sessions = new FakeSessions();
    const { service } = build({ sessions, scoring: { dispatch } });
    await service.loadState(TOKEN);
    await service.saveAnswers(TOKEN, completeAnswers());
    const result = await service.submit(TOKEN);
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(SESSION_ID);
    // Dispatch runs only after the session is completed.
    expect(sessions.completed).toEqual(NOW);
  });

  it('does not dispatch scoring when submit is rejected', async () => {
    const dispatch = vi.fn(async () => ok(null));
    const { service } = build({ scoring: { dispatch } });
    await service.loadState(TOKEN);
    const result = await service.submit(TOKEN); // nothing answered
    expect(result.ok).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('still succeeds when scoring dispatch returns an error result', async () => {
    const dispatch = vi.fn(async () =>
      err({ code: 'scoring/queue_unavailable', message: 'no queue' })
    );
    const { service, responses } = build({ scoring: { dispatch } });
    await service.loadState(TOKEN);
    await service.saveAnswers(TOKEN, completeAnswers());
    const result = await service.submit(TOKEN);
    expect(result.ok).toBe(true);
    expect(responses.rows.get(SESSION_ID)?.status).toBe('submitted');
    expect(dispatch).toHaveBeenCalledWith(SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// Visibility hook (C5 seam)
// ---------------------------------------------------------------------------

describe('visibility evaluator seam', () => {
  const hideIpsative: VisibilityEvaluator = {
    isSectionVisible: () => true,
    isQuestionVisible: (_definition, q) => q.key !== 'q_ips',
  };

  it('excludes hidden questions from progress totals and submit gating', async () => {
    const { service } = build({ visibility: hideIpsative });
    const state = await service.loadState(TOKEN);
    if (!state.ok) throw new Error('expected ok');
    expect(state.value.progress.totalCount).toBe(4); // q_ips excluded
    const patch = completeAnswers();
    delete (patch as Record<string, unknown>).q_ips;
    await service.saveAnswers(TOKEN, patch);
    const result = await service.submit(TOKEN);
    expect(result.ok).toBe(true);
  });

  it('retains but flags answers to hidden questions at submit', async () => {
    // Answer everything (q_ips included) while visible, then hide it.
    const responses = new FakeResponses();
    const visible = build({ responses });
    await visible.service.loadState(TOKEN);
    await visible.service.saveAnswers(TOKEN, completeAnswers());

    const hidden = build({ responses, visibility: hideIpsative });
    const result = await hidden.service.submit(TOKEN);
    expect(result.ok).toBe(true);
    const stored = responses.rows.get(SESSION_ID);
    expect(stored?.answers.q_ips?.hidden).toBe(true);
    expect(stored?.answers.q_ips?.value).toEqual({ most: 'i1', least: 'i3' });
    expect(stored?.answers.q_likert?.hidden).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Branching integration (C5 — real showIf evaluator, the service default)
// ---------------------------------------------------------------------------

/**
 * s1: q_gate (yes/no) + q_dep (required, showIf q_gate = 'yes')
 * s2: showIf q_gate = 'yes' — q_s2 (required)
 * s3: q_cascade (required, showIf answered q_s2) + q_end (required, always)
 */
const branchingInput: QuestionnaireDefinitionInput = {
  schemaVersion: 1,
  key: 'branching-def',
  titleKey: 'b.title',
  settings: { progressBar: true, allowBack: true },
  sections: [
    {
      key: 's1',
      questions: [
        {
          key: 'q_gate',
          type: 'multiple_choice',
          textKey: 'b.gate',
          multi: false,
          options: [
            { key: 'yes', labelKey: 'b.yes' },
            { key: 'no', labelKey: 'b.no' },
          ],
        },
        {
          key: 'q_dep',
          type: 'likert',
          textKey: 'b.dep',
          scale: { min: 1, max: 5, labelKeys: {}, presentation: 'radio' },
          showIf: { op: 'eq', question: 'q_gate', value: 'yes' },
        },
      ],
    },
    {
      key: 's2',
      showIf: { op: 'eq', question: 'q_gate', value: 'yes' },
      questions: [
        {
          key: 'q_s2',
          type: 'free_text',
          textKey: 'b.s2',
          multiline: false,
        },
      ],
    },
    {
      key: 's3',
      questions: [
        {
          key: 'q_cascade',
          type: 'free_text',
          textKey: 'b.cascade',
          multiline: false,
          showIf: { op: 'answered', question: 'q_s2' },
        },
        {
          key: 'q_end',
          type: 'free_text',
          textKey: 'b.end',
          multiline: false,
        },
      ],
    },
  ],
};

describe('branching integration (real showIf evaluator)', () => {
  function buildBranching(responses = new FakeResponses()) {
    // No explicit `visibility` — proves showIfVisibility is the default.
    return build({ responses, versions: fakeVersions(branchingInput) });
  }

  it('counts only currently-visible required questions in progress', async () => {
    const { service } = buildBranching();
    const state = await service.loadState(TOKEN);
    if (!state.ok) throw new Error('expected ok');
    // Visible: q_gate, q_end (q_dep/q_s2 need q_gate='yes'; q_cascade needs q_s2)
    expect(state.value.progress).toEqual({
      currentSectionKey: null,
      answeredCount: 0,
      totalCount: 2,
    });
  });

  it('reveals dependent questions when the gate answer is saved', async () => {
    const { service } = buildBranching();
    await service.loadState(TOKEN);
    const result = await service.saveAnswers(TOKEN, {
      q_gate: record({ type: 'multiple_choice', value: 'yes' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Visible required: q_gate, q_dep, q_s2, q_end (q_cascade still hidden)
    expect(result.value.progress).toEqual({
      currentSectionKey: null,
      answeredCount: 1,
      totalCount: 4,
    });
  });

  it('excludes hidden required questions from submit gating', async () => {
    const { service } = buildBranching();
    await service.loadState(TOKEN);
    await service.saveAnswers(TOKEN, {
      q_gate: record({ type: 'multiple_choice', value: 'no' }),
      q_end: record({ type: 'free_text', value: 'done' }),
    });
    // q_dep, q_s2, q_cascade are required but hidden — submit must pass.
    const result = await service.submit(TOKEN);
    expect(result.ok).toBe(true);
  });

  it('blocks submit on visible required questions revealed by branching', async () => {
    const { service } = buildBranching();
    await service.loadState(TOKEN);
    await service.saveAnswers(TOKEN, {
      q_gate: record({ type: 'multiple_choice', value: 'yes' }),
      q_end: record({ type: 'free_text', value: 'done' }),
    });
    const result = await service.submit(TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('questionnaire/incomplete');
    expect((result.error.detail as { missing: string[] }).missing.sort()).toEqual([
      'q_dep',
      'q_s2',
    ]);
  });

  it('retains but flags answers hidden by flipping the gate (incl. cascade)', async () => {
    const responses = new FakeResponses();
    const { service } = buildBranching(responses);
    await service.loadState(TOKEN);
    // Answer everything down the 'yes' branch...
    await service.saveAnswers(TOKEN, {
      q_gate: record({ type: 'multiple_choice', value: 'yes' }),
      q_dep: record({ type: 'likert', value: 4 }),
      q_s2: record({ type: 'free_text', value: 'branch answer' }),
      q_cascade: record({ type: 'free_text', value: 'cascade answer' }),
      q_end: record({ type: 'free_text', value: 'done' }),
    });
    // ...then flip the gate: q_dep + q_s2 hide directly, q_cascade hides
    // because the retained q_s2 answer no longer counts (cascading).
    await service.saveAnswers(TOKEN, {
      q_gate: record({ type: 'multiple_choice', value: 'no' }),
    });
    const result = await service.submit(TOKEN);
    expect(result.ok).toBe(true);
    const stored = responses.rows.get(SESSION_ID);
    expect(stored?.answers.q_dep?.hidden).toBe(true);
    expect(stored?.answers.q_s2?.hidden).toBe(true);
    expect(stored?.answers.q_cascade?.hidden).toBe(true);
    expect(stored?.answers.q_s2?.value).toBe('branch answer'); // retained
    expect(stored?.answers.q_gate?.hidden).toBeUndefined();
    expect(stored?.answers.q_end?.hidden).toBeUndefined();
  });

  it('rejects saving position on a section hidden by branching', async () => {
    const { service } = buildBranching();
    await service.loadState(TOKEN);
    const hidden = await service.savePosition(TOKEN, 's2');
    expect(hidden.ok).toBe(false);
    if (hidden.ok) return;
    expect(hidden.error.code).toBe('questionnaire/section_invalid');

    await service.saveAnswers(TOKEN, {
      q_gate: record({ type: 'multiple_choice', value: 'yes' }),
    });
    const visible = await service.savePosition(TOKEN, 's2');
    expect(visible.ok).toBe(true);
  });
});
