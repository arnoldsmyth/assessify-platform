import { createHmac } from 'node:crypto';
import { scoringConfigSchema, type ScoringConfig } from '@assessify/domain';
import { describe, expect, it } from 'vitest';

import type { ScoringInput } from '../types';
import {
  buildPrologicToolResponses,
  createPrologicReferenceClient,
  createPrologicScoringAdapter,
  normalizePrologicEnvelope,
  parsePrologicScopeCatalog,
  parsePrologicScoredEvent,
  prologicRegistrationIdempotencyKey,
  prologicScoreIdempotencyKey,
  PrologicWebhookPayloadError,
  toolResponsesToList,
  verifyPrologicWebhookSignature,
  type FetchLike,
} from './prologic';

const JOB_ID = '01890000-0000-7000-8000-000000000001';
const SESSION_ID = '01890000-0000-7000-8000-00000000aaaa';
const RESPONDENT_ID = '01890000-0000-7000-8000-00000000cafe';
const ASSESSMENT_ID = '01HZXKQ8W9GYV2M4T6R8PLGSCB';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function prologicConfig(overrides: Record<string, unknown> = {}): ScoringConfig {
  return scoringConfigSchema.parse({
    mode: 'async_external',
    provider: 'prologic',
    accessCode: 'ac_test123',
    scopes: ['mcs'],
    toolMap: {
      person: { q1: 1, q2: 2 },
      role: { q3: 1 },
    },
    ...overrides,
  });
}

function scoringInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    jobId: JOB_ID,
    sessionId: SESSION_ID,
    product: { id: '01890000-0000-7000-8000-00000000cccc', externalIds: {} },
    questionnaire: { key: 'test-def', version: 3, variant: 'self' },
    answers: { q1: 4, q2: 'opt_b', q3: 2 },
    respondentMeta: { language: 'en' },
    respondent: {
      id: RESPONDENT_ID,
      firstname: 'Jane',
      lastname: 'Doe',
      email: 'jane@example.com',
    },
    config: prologicConfig(),
    ...overrides,
  };
}

interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    assessment_id: ASSESSMENT_ID,
    external_id: RESPONDENT_ID,
    scored_at: '2026-07-21T10:00:00Z',
    language: 'en',
    format: 'keys',
    norms: { set_id: 'norms-2026-male', provisional: true },
    scopes: { mcs: { m: { drive: 72.5, focus: 41 }, archetype: 'builder' } },
    ...overrides,
  };
}

/**
 * Route-based fetch double: matches `METHOD /path` (base URL stripped) and
 * records every call. Unmatched routes 404.
 */
function fakeFetch(
  routes: Record<string, ((call: RecordedCall) => Response) | Response>
): { fetchFn: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key.toLowerCase()] = value as string;
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: RecordedCall = { method, path, headers, body };
    calls.push(call);
    const route = routes[`${method} ${path}`];
    if (route === undefined) return jsonResponse(404, { error: { code: 'not_found', message: 'no' } });
    return typeof route === 'function' ? route(call) : route.clone();
  };
  return { fetchFn, calls };
}

/** The happy-path route table: register → two tool PUTs → score. */
function happyRoutes() {
  return {
    'POST /v2/assessments': () => jsonResponse(201, { assessment_id: ASSESSMENT_ID }),
    [`PUT /v2/assessments/${ASSESSMENT_ID}/tools/person`]: () =>
      jsonResponse(200, { assessment_id: ASSESSMENT_ID }),
    [`PUT /v2/assessments/${ASSESSMENT_ID}/tools/role`]: () =>
      jsonResponse(200, { assessment_id: ASSESSMENT_ID }),
    [`POST /v2/assessments/${ASSESSMENT_ID}/score`]: () => jsonResponse(200, envelope()),
  };
}

const catalogReference = {
  async requiredToolsForScopes() {
    return { mcs: ['person', 'role'] as ('person' | 'role')[] };
  },
};

function buildAdapter(
  routes: Record<string, ((call: RecordedCall) => Response) | Response>,
  options: { reference?: typeof catalogReference | undefined } = { reference: catalogReference }
) {
  const { fetchFn, calls } = fakeFetch(routes);
  const adapter = createPrologicScoringAdapter({
    apiKey: 'key_test',
    baseUrl: 'https://engine.example',
    fetchFn,
    ...(options.reference !== undefined ? { reference: options.reference } : {}),
  });
  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// Tool mapping
// ---------------------------------------------------------------------------

describe('buildPrologicToolResponses', () => {
  it('groups answers per tool as a 1-based {q: a} map', () => {
    const responses = buildPrologicToolResponses(
      { q1: 4, q2: 'opt_b', q3: 2 },
      { person: { q1: 1, q2: 2 }, role: { q3: 1 } }
    );
    expect(responses).toEqual({
      person: { '1': 4, '2': 'opt_b' },
      role: { '1': 2 },
    });
  });

  it('skips unanswered question keys and omits empty tools entirely', () => {
    const responses = buildPrologicToolResponses(
      { q1: 4 },
      { person: { q1: 1, q_unanswered: 2 }, organization: { q9: 1 } }
    );
    expect(responses).toEqual({ person: { '1': 4 } });
  });

  it('converts to the [{q, a}] list form the API also accepts, sorted by q', () => {
    expect(toolResponsesToList({ '2': 'opt_b', '1': 4 })).toEqual([
      { q: 1, a: 4 },
      { q: 2, a: 'opt_b' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

describe('idempotency keys', () => {
  it('registration key is deterministic per respondent+session, ids only', () => {
    const key = prologicRegistrationIdempotencyKey(RESPONDENT_ID, SESSION_ID);
    expect(key).toBe(`assessify:reg:${RESPONDENT_ID}:${SESSION_ID}`);
    expect(key).toBe(prologicRegistrationIdempotencyKey(RESPONDENT_ID, SESSION_ID));
  });

  it('score key is stable per job', () => {
    expect(prologicScoreIdempotencyKey(JOB_ID)).toBe(`assessify:score:${JOB_ID}`);
  });
});

// ---------------------------------------------------------------------------
// Full score flow
// ---------------------------------------------------------------------------

describe('createPrologicScoringAdapter — score flow', () => {
  it('registers, submits each mapped tool, scores, and returns a sync_result', async () => {
    const { adapter, calls } = buildAdapter(happyRoutes());
    const outcome = await adapter.score(scoringInput());

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v2/assessments',
      `PUT /v2/assessments/${ASSESSMENT_ID}/tools/person`,
      `PUT /v2/assessments/${ASSESSMENT_ID}/tools/role`,
      `POST /v2/assessments/${ASSESSMENT_ID}/score`,
    ]);

    const register = calls[0]!;
    expect(register.headers['authorization']).toBe('Bearer key_test');
    expect(register.headers['idempotency-key']).toBe(
      prologicRegistrationIdempotencyKey(RESPONDENT_ID, SESSION_ID)
    );
    expect(register.body).toEqual({
      firstname: 'Jane',
      lastname: 'Doe',
      email: 'jane@example.com',
      language: 'en',
      gender: null,
      external_id: RESPONDENT_ID,
    });

    expect(calls[1]!.body).toEqual({ responses: { '1': 4, '2': 'opt_b' } });
    expect(calls[2]!.body).toEqual({ responses: { '1': 2 } });

    const score = calls[3]!;
    expect(score.headers['idempotency-key']).toBe(prologicScoreIdempotencyKey(JOB_ID));
    expect(score.body).toEqual({
      scopes: ['mcs'],
      format: 'keys',
      access_code: 'ac_test123',
      audit: false,
    });

    expect(outcome.kind).toBe('sync_result');
    if (outcome.kind !== 'sync_result') return;
    expect(outcome.externalRef).toEqual({ provider: 'prologic', assessmentId: ASSESSMENT_ID });
    expect(outcome.scores.dimensions).toEqual({ 'mcs.m.drive': 72.5, 'mcs.m.focus': 41 });
  });

  it('registers with external_id = respondents.id (the royalty anchor), never session/order ids', async () => {
    const { adapter, calls } = buildAdapter(happyRoutes());
    await adapter.score(scoringInput());
    const body = calls[0]!.body as { external_id: string };
    expect(body.external_id).toBe(RESPONDENT_ID);
    expect(body.external_id).not.toBe(SESSION_ID);
    expect(body.external_id).not.toBe(JOB_ID);
  });

  it('passes the configured norms selector and normalizes pt-BR → pt', async () => {
    const { adapter, calls } = buildAdapter(happyRoutes());
    const outcome = await adapter.score(
      scoringInput({
        config: prologicConfig({ norms: 'pooled' }),
        respondentMeta: { language: 'pt-BR' },
      })
    );
    expect(outcome.kind).toBe('sync_result');
    expect((calls[0]!.body as { language: string }).language).toBe('pt');
    expect((calls[3]!.body as { norms: string }).norms).toBe('pooled');
  });

  it('never leaks respondent identity into outcomes or error strings', async () => {
    const { adapter } = buildAdapter({
      'POST /v2/assessments': () =>
        jsonResponse(422, { error: { code: 'validation', message: 'email jane@example.com bad' } }),
    });
    const outcome = await adapter.score(scoringInput());
    expect(outcome.kind).toBe('failed');
    expect(JSON.stringify(outcome)).not.toContain('jane@example.com');
    expect(JSON.stringify(outcome)).not.toContain('Jane');
  });

  it('fails permanently when respondent identity is absent', async () => {
    const { adapter, calls } = buildAdapter(happyRoutes());
    const respondentless = { ...scoringInput() };
    delete respondentless.respondent;
    const outcome = await adapter.score(respondentless);
    expect(outcome).toEqual({
      kind: 'failed',
      retryable: false,
      error: 'prologic_respondent_identity_missing',
    });
    expect(calls).toHaveLength(0); // nothing was sent
  });

  it('fails permanently on a language outside en|fr|pt', async () => {
    const { adapter } = buildAdapter(happyRoutes());
    const outcome = await adapter.score(scoringInput({ respondentMeta: { language: 'de' } }));
    expect(outcome).toMatchObject({ kind: 'failed', retryable: false });
    if (outcome.kind !== 'failed') return;
    expect(outcome.error).toBe('prologic_unsupported_language');
  });

  it('fails permanently when the config is not a prologic config', async () => {
    const outcome = await buildAdapter(happyRoutes()).adapter.score(
      scoringInput({
        config: scoringConfigSchema.parse({
          mode: 'async_external',
          endpoint: 'https://other.example',
        }),
      })
    );
    expect(outcome).toMatchObject({ kind: 'failed', retryable: false });
    if (outcome.kind !== 'failed') return;
    expect(outcome.error).toContain('prologic_config_invalid');
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('createPrologicScoringAdapter — error classification', () => {
  it('5xx on registration is retryable', async () => {
    const { adapter } = buildAdapter({
      'POST /v2/assessments': () => jsonResponse(503, { error: { code: 'down', message: 'x' } }),
    });
    const outcome = await adapter.score(scoringInput());
    expect(outcome).toMatchObject({ kind: 'failed', retryable: true });
  });

  it('401 on registration (bad API key) is permanent', async () => {
    const { adapter } = buildAdapter({
      'POST /v2/assessments': () => jsonResponse(401, { error: { code: 'unauthorized', message: 'x' } }),
    });
    const outcome = await adapter.score(scoringInput());
    expect(outcome).toMatchObject({ kind: 'failed', retryable: false });
  });

  it('a tool 422 is permanent and carries a compact per-item detail', async () => {
    const { adapter } = buildAdapter({
      'POST /v2/assessments': () => jsonResponse(201, { assessment_id: ASSESSMENT_ID }),
      [`PUT /v2/assessments/${ASSESSMENT_ID}/tools/person`]: () =>
        jsonResponse(422, {
          error: {
            code: 'invalid_responses',
            message: 'nope',
            details: [
              { tool: 'person', q: 2, rule: 'range', expected: '1..5', got: 9 },
              { tool: 'person', q: 1, rule: 'required' },
            ],
          },
        }),
    });
    const outcome = await adapter.score(scoringInput());
    expect(outcome).toMatchObject({ kind: 'failed', retryable: false });
    if (outcome.kind !== 'failed') return;
    expect(outcome.error).toBe('prologic_tool_rejected:person:q2:range,q1:required');
    // registration happened → the webhook can still correlate this job.
    expect(outcome.externalRef).toEqual({ provider: 'prologic', assessmentId: ASSESSMENT_ID });
  });

  it('a score 403 (access-code problem) is permanent', async () => {
    const { adapter } = buildAdapter({
      ...happyRoutes(),
      [`POST /v2/assessments/${ASSESSMENT_ID}/score`]: () =>
        jsonResponse(403, { error: { code: 'scope_not_allowed', message: 'x' } }),
    });
    const outcome = await adapter.score(scoringInput());
    expect(outcome).toMatchObject({ kind: 'failed', retryable: false });
    if (outcome.kind !== 'failed') return;
    expect(outcome.error).toBe('prologic_access_code_rejected:scope_not_allowed');
  });

  it('a score 422 (missing tools / norm problem) is permanent', async () => {
    const { adapter } = buildAdapter({
      ...happyRoutes(),
      [`POST /v2/assessments/${ASSESSMENT_ID}/score`]: () =>
        jsonResponse(422, { error: { code: 'missing_tools', message: 'x' } }),
    });
    const outcome = await adapter.score(scoringInput());
    expect(outcome).toMatchObject({
      kind: 'failed',
      retryable: false,
      error: 'prologic_score_rejected:missing_tools',
    });
  });

  it('a score 5xx is retryable and still carries the externalRef for webhook rescue', async () => {
    const { adapter } = buildAdapter({
      ...happyRoutes(),
      [`POST /v2/assessments/${ASSESSMENT_ID}/score`]: () =>
        jsonResponse(500, { error: { code: 'oops', message: 'x' } }),
    });
    const outcome = await adapter.score(scoringInput());
    expect(outcome).toMatchObject({ kind: 'failed', retryable: true });
    if (outcome.kind !== 'failed') return;
    expect(outcome.externalRef).toEqual({ provider: 'prologic', assessmentId: ASSESSMENT_ID });
  });

  it('network failures are retryable', async () => {
    const adapter = createPrologicScoringAdapter({
      apiKey: 'key_test',
      baseUrl: 'https://engine.example',
      fetchFn: async () => {
        throw new TypeError('fetch failed');
      },
      reference: catalogReference,
    });
    const outcome = await adapter.score(scoringInput());
    expect(outcome).toMatchObject({ kind: 'failed', retryable: true });
  });
});

// ---------------------------------------------------------------------------
// Reference catalog gating
// ---------------------------------------------------------------------------

describe('reference catalog', () => {
  it('parses wrapper, bare-map and array catalog shapes', () => {
    const expected = { mcs: ['person', 'role'] };
    expect(
      parsePrologicScopeCatalog({ scopes: { mcs: { required_tools: ['person', 'role'] } } })
    ).toEqual(expected);
    expect(parsePrologicScopeCatalog({ mcs: { requiredTools: ['person', 'role'] } })).toEqual(
      expected
    );
    expect(
      parsePrologicScopeCatalog([{ scope: 'mcs', tools: ['person', 'role', 'not-a-tool'] }])
    ).toEqual(expected);
    expect(parsePrologicScopeCatalog('garbage')).toEqual({});
  });

  it('blocks dispatch with a permanent error naming the missing tools', async () => {
    const { adapter, calls } = buildAdapter(happyRoutes(), {
      reference: {
        async requiredToolsForScopes() {
          return { mcs: ['person', 'role', 'organization'] as never };
        },
      },
    });
    const outcome = await adapter.score(scoringInput());
    expect(outcome).toEqual({
      kind: 'failed',
      retryable: false,
      error: 'prologic_missing_tools:mcs:organization',
    });
    expect(calls).toHaveLength(0); // gated before registration
  });

  it('an unavailable catalog is a retryable failure', async () => {
    const { adapter } = buildAdapter(
      {
        'GET /v2/reference/scopes': () => jsonResponse(500, { error: { code: 'down', message: 'x' } }),
      },
      { reference: undefined }
    );
    const outcome = await adapter.score(scoringInput());
    expect(outcome).toMatchObject({ kind: 'failed', retryable: true });
  });

  it('caches the catalog in-process across calls (TTL)', async () => {
    const { fetchFn, calls } = fakeFetch({
      'GET /v2/reference/scopes': () =>
        jsonResponse(200, { scopes: { mcs: { required_tools: ['person'] } } }),
    });
    let nowMs = 0;
    const client = createPrologicReferenceClient({
      apiKey: 'key_test',
      baseUrl: 'https://engine.example',
      fetchFn,
      ttlMs: 1000,
      now: () => nowMs,
    });
    expect(await client.requiredToolsForScopes(['mcs'])).toEqual({ mcs: ['person'] });
    expect(await client.requiredToolsForScopes(['mcs', 'unknown-scope'])).toEqual({
      mcs: ['person'],
    });
    expect(calls).toHaveLength(1); // second call served from cache
    nowMs = 2000;
    await client.requiredToolsForScopes(['mcs']);
    expect(calls).toHaveLength(2); // TTL expired → refetched
  });
});

// ---------------------------------------------------------------------------
// Envelope normalization
// ---------------------------------------------------------------------------

describe('normalizePrologicEnvelope', () => {
  it('flattens numeric leaves into dimensions and keeps the envelope in raw', () => {
    const scores = normalizePrologicEnvelope(
      parsePrologicScoredEvent(
        envelope({
          scopes: {
            mcs: { m: { drive: 72.5 }, ranked: [3, 1] },
            insights: { archetype: 'builder' },
          },
        })
      )
    );
    expect(scores.dimensions).toEqual({
      'mcs.m.drive': 72.5,
      'mcs.ranked.0': 3,
      'mcs.ranked.1': 1,
    });
    const raw = scores.raw as Record<string, unknown>;
    expect(raw['provider']).toBe('prologic');
    expect(raw['assessment_id']).toBe(ASSESSMENT_ID);
    expect((raw['scopes'] as Record<string, unknown>)['insights']).toEqual({
      archetype: 'builder',
    });
  });

  it('records norms.set_id forever on the result (norm-set contract)', () => {
    const scores = normalizePrologicEnvelope(parsePrologicScoredEvent(envelope()));
    expect((scores.raw as { norms: { set_id: string } }).norms.set_id).toBe('norms-2026-male');
    const noNorms = normalizePrologicEnvelope(
      parsePrologicScoredEvent(envelope({ norms: undefined }))
    );
    expect((noNorms.raw as { norms: { set_id: null } }).norms.set_id).toBeNull();
  });

  it('drops the webhook event marker from raw', () => {
    const scores = normalizePrologicEnvelope(
      parsePrologicScoredEvent({ ...envelope(), event: 'scored' })
    );
    expect((scores.raw as Record<string, unknown>)['event']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Webhook signature + payload
// ---------------------------------------------------------------------------

describe('verifyPrologicWebhookSignature', () => {
  const secret = 'whsec_prologic_test';
  const payload = JSON.stringify({ ...envelope(), event: 'scored' });
  const hex = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  const b64 = createHmac('sha256', secret).update(payload, 'utf8').digest('base64');

  it('accepts a valid hex signature (with or without sha256= prefix)', () => {
    expect(verifyPrologicWebhookSignature({ secret, payload, signature: hex })).toBe(true);
    expect(
      verifyPrologicWebhookSignature({ secret, payload, signature: `sha256=${hex}` })
    ).toBe(true);
  });

  it('accepts a valid base64 signature', () => {
    expect(verifyPrologicWebhookSignature({ secret, payload, signature: b64 })).toBe(true);
  });

  it('rejects a signature over a tampered body', () => {
    expect(
      verifyPrologicWebhookSignature({ secret, payload: `${payload} `, signature: hex })
    ).toBe(false);
  });

  it('rejects wrong-secret, empty and garbage signatures', () => {
    const other = createHmac('sha256', 'other-secret').update(payload, 'utf8').digest('hex');
    expect(verifyPrologicWebhookSignature({ secret, payload, signature: other })).toBe(false);
    expect(verifyPrologicWebhookSignature({ secret, payload, signature: '' })).toBe(false);
    expect(verifyPrologicWebhookSignature({ secret, payload, signature: '!!not-a-digest!!' })).toBe(
      false
    );
  });
});

describe('parsePrologicScoredEvent', () => {
  it('parses a scored envelope', () => {
    const parsed = parsePrologicScoredEvent({ ...envelope(), event: 'scored' });
    expect(parsed.assessment_id).toBe(ASSESSMENT_ID);
  });

  it('throws PrologicWebhookPayloadError on malformed payloads (paths only)', () => {
    expect(() => parsePrologicScoredEvent({ event: 'scored' })).toThrow(
      PrologicWebhookPayloadError
    );
    expect(() => parsePrologicScoredEvent({ event: 'scored' })).toThrow(/assessment_id/);
  });
});
