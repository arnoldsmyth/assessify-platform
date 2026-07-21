import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  prologicToolSchema,
  scoreSetSchema,
  type PrologicTool,
  type PrologicToolMap,
  type ScoreSet,
  type ScoringAnswers,
} from '@assessify/domain';

import type {
  ScoringAdapter,
  ScoringExternalRef,
  ScoringInput,
  ScoringOutcome,
  ScoringRespondentIdentity,
} from '../types';

/**
 * Pro-Logic external scoring provider (E2 — docs/pro-logic-openapi.json,
 * Scoring Engine API v2.0). Serves `scoring_config.mode = 'async_external'`
 * with `provider = 'prologic'`.
 *
 * Although the platform models external engines as async, Pro-Logic's
 * `POST /v2/assessments/{id}/score` is SYNCHRONOUS: register → submit tools →
 * score all happen inside one `score()` call and the outcome is
 * `sync_result`, applied immediately by the scoring service. The `scored`
 * webhook (apps/web/app/api/webhooks/prologic) is a redundant confirmation
 * path — it replays through the idempotent `applyScores`, and it rescues the
 * edge where Pro-Logic scored but our read of the response failed.
 *
 * CRITICAL billing rule (owner, 2026-07-21): `external_id` MUST be
 * `respondents.id` — the stable per-person id reused across orders and
 * rescores. Pro-Logic bills a royalty per external_id on royalty-bearing
 * products; sending order/session ids would double-charge rescores.
 *
 * PII: registration requires firstname/lastname/email/language — the
 * documented payload-contract exception to the no-PII rule (spec 00/08).
 * These fields go to Pro-Logic and NOWHERE else: never into error strings,
 * outcomes, logs, or the job's request/response payload snapshots.
 */

export const PROLOGIC_PROVIDER = 'prologic';
export const PROLOGIC_DEFAULT_BASE_URL = 'https://pro-logic.arntek.com';

/** Webhook headers (OpenAPI `webhooks.scored`): HMAC of the RAW body. */
export const PROLOGIC_SIGNATURE_HEADER = 'x-signature';
export const PROLOGIC_EVENT_HEADER = 'x-event';
export const PROLOGIC_SCORED_EVENT = 'scored';

const DEFAULT_REFERENCE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_SECONDS = 30;

// ---------------------------------------------------------------------------
// Wire schemas (OpenAPI shapes → Zod at the boundary)
// ---------------------------------------------------------------------------

/** `components.schemas.Error` — `{ error: { code, message, details? } }`. */
const prologicErrorBodySchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** Per-item tool validation errors (`PUT …/tools/{tool}` 422). */
const prologicToolIssueSchema = z
  .object({
    tool: z.string().optional(),
    q: z.union([z.number(), z.string()]).optional(),
    rule: z.string().optional(),
    expected: z.unknown().optional(),
  })
  .passthrough();

const prologicAssessmentStatusSchema = z
  .object({
    assessment_id: z.string().min(1),
    external_id: z.string().nullable().optional(),
  })
  .passthrough();

const prologicNormsSchema = z
  .object({
    /** Recorded forever on the result; 'none' when no scope uses norms. */
    set_id: z.string().optional(),
    provisional: z.boolean().optional(),
  })
  .passthrough();

/** `components.schemas.ResultEnvelope` (also the webhook body + `event`). */
export const prologicResultEnvelopeSchema = z
  .object({
    assessment_id: z.string().min(1),
    external_id: z.string().nullable().optional(),
    scored_at: z.string().optional(),
    language: z.string().optional(),
    format: z.enum(['keys', 'strings']).optional(),
    norms: prologicNormsSchema.optional(),
    scopes: z.record(z.unknown()).optional(),
    event: z.literal('scored').optional(),
  })
  .passthrough();
export type PrologicResultEnvelope = z.infer<typeof prologicResultEnvelopeSchema>;

/** The prologic-relevant subset of `products.scoring_config` (re-validated here). */
const prologicRuntimeConfigSchema = z
  .object({
    provider: z.literal('prologic'),
    accessCode: z.string().min(1),
    scopes: z.array(z.string().min(1)).min(1),
    toolMap: z.record(prologicToolSchema, z.record(z.string().min(1), z.number().int().min(1))),
    norms: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).max(600).default(DEFAULT_TIMEOUT_SECONDS),
  })
  .passthrough();

const registrationLanguageSchema = z.enum(['en', 'fr', 'pt']);

// ---------------------------------------------------------------------------
// Webhook verification + parsing (used by /api/webhooks/prologic)
// ---------------------------------------------------------------------------

export class PrologicWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrologicWebhookPayloadError';
  }
}

export interface VerifyPrologicSignatureInput {
  /** Webhook secret for our API key — from env at the composition root. */
  secret: string;
  /** Raw request body, byte-for-byte as received (HMAC is over RAW bytes). */
  payload: string;
  /** `X-Signature` header value. */
  signature: string;
}

/**
 * Verify the `X-Signature` HMAC-SHA256 of the raw webhook body. Returns
 * false (never throws) on any mismatch so the route replies 401 uniformly.
 * The OpenAPI spec does not pin the digest encoding, so hex and base64 are
 * both accepted (optionally prefixed `sha256=`); comparison is constant-time.
 */
export function verifyPrologicWebhookSignature(input: VerifyPrologicSignatureInput): boolean {
  try {
    const raw = input.signature.trim();
    const candidateText = raw.toLowerCase().startsWith('sha256=') ? raw.slice(7).trim() : raw;
    if (candidateText.length === 0) return false;
    const expected = createHmac('sha256', input.secret).update(input.payload, 'utf8').digest();

    const candidates: Buffer[] = [];
    if (/^[0-9a-f]+$/i.test(candidateText) && candidateText.length % 2 === 0) {
      candidates.push(Buffer.from(candidateText, 'hex'));
    }
    if (/^[A-Za-z0-9+/=_-]+$/.test(candidateText)) {
      candidates.push(Buffer.from(candidateText.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    }
    return candidates.some(
      (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected)
    );
  } catch {
    return false;
  }
}

/**
 * Parse a `scored` webhook body into a ResultEnvelope. Throws
 * {@link PrologicWebhookPayloadError} on malformed payloads (route → 400).
 */
export function parsePrologicScoredEvent(payload: unknown): PrologicResultEnvelope {
  const parsed = prologicResultEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    // Issue paths only — never echo payload values into errors.
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw new PrologicWebhookPayloadError(`invalid scored envelope: ${paths}`);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Envelope → ScoreSet normalization
// ---------------------------------------------------------------------------

const FLATTEN_MAX_DEPTH = 8;
const FLATTEN_MAX_ENTRIES = 2000;
const FLATTEN_MAX_KEY_LENGTH = 200;

function flattenNumericLeaves(
  value: unknown,
  path: string,
  depth: number,
  out: Record<string, number>
): void {
  if (Object.keys(out).length >= FLATTEN_MAX_ENTRIES || depth > FLATTEN_MAX_DEPTH) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (path.length > 0 && path.length <= FLATTEN_MAX_KEY_LENGTH) out[path] = value;
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenNumericLeaves(item, path ? `${path}.${index}` : String(index), depth + 1, out);
    });
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      flattenNumericLeaves(item, path ? `${path}.${key}` : key, depth + 1, out);
    }
  }
}

/**
 * Normalize a Pro-Logic ResultEnvelope into E1's ScoreSet:
 * - `dimensions`: every finite numeric leaf of `scopes`, keyed by its
 *   dot-joined path (e.g. `mcs.m.drive`) — the scope output catalog is
 *   engine-owned, so extraction is structural rather than shape-aware;
 * - `raw`: the full envelope verbatim (minus the webhook `event` marker),
 *   which preserves `norms.set_id` — the norm set is recorded forever on the
 *   result per the Pro-Logic contract — plus assessment/external ids.
 * The envelope carries no respondent PII (ids, keys and numbers only).
 */
export function normalizePrologicEnvelope(envelope: PrologicResultEnvelope): ScoreSet {
  const dimensions: Record<string, number> = {};
  flattenNumericLeaves(envelope.scopes ?? {}, '', 0, dimensions);
  const { event: _event, ...raw } = envelope;
  return scoreSetSchema.parse({
    dimensions,
    raw: {
      provider: PROLOGIC_PROVIDER,
      ...raw,
      norms: { set_id: envelope.norms?.set_id ?? null, ...envelope.norms },
    },
  });
}

// ---------------------------------------------------------------------------
// Tool mapping (questionnaire question keys → Pro-Logic (tool, 1-based q))
// ---------------------------------------------------------------------------

/** `{q: a}` map form — what `PUT …/tools/{tool}` receives from us. */
export type PrologicToolResponses = Partial<Record<PrologicTool, Record<string, unknown>>>;

/**
 * Group the (PII-free) answers into per-tool `{q: a}` response maps using
 * the product's toolMap. Unanswered question keys are skipped; tools with no
 * answered questions are omitted entirely (tools are submitted incrementally
 * as completed — scope gating decides whether that is a problem).
 */
export function buildPrologicToolResponses(
  answers: ScoringAnswers,
  toolMap: PrologicToolMap
): PrologicToolResponses {
  const out: PrologicToolResponses = {};
  for (const [tool, questions] of Object.entries(toolMap) as [
    PrologicTool,
    Record<string, number>,
  ][]) {
    const responses: Record<string, unknown> = {};
    for (const [questionKey, q] of Object.entries(questions ?? {})) {
      const answer = answers[questionKey];
      if (answer !== undefined) responses[String(q)] = answer;
    }
    if (Object.keys(responses).length > 0) out[tool] = responses;
  }
  return out;
}

/** The equivalent `[{q, a}]` list form of one tool's responses (also accepted by the API). */
export function toolResponsesToList(
  responses: Record<string, unknown>
): { q: number; a: unknown }[] {
  return Object.entries(responses)
    .map(([q, a]) => ({ q: Number(q), a }))
    .sort((left, right) => left.q - right.q);
}

// ---------------------------------------------------------------------------
// Idempotency keys — ids only, never PII
// ---------------------------------------------------------------------------

/**
 * Registration replay key: stable per respondent+session so worker retries
 * replay the same registration (same key + same payload → stored response)
 * while a re-score (new session) registers afresh — but always under the
 * SAME `external_id` (`respondents.id`), which is what dedupes royalties.
 */
export function prologicRegistrationIdempotencyKey(
  respondentId: string,
  sessionId: string
): string {
  return `assessify:reg:${respondentId}:${sessionId}`;
}

/** Score replay key: stable per scoring job. */
export function prologicScoreIdempotencyKey(jobId: string): string {
  return `assessify:score:${jobId}`;
}

// ---------------------------------------------------------------------------
// HTTP plumbing (plain fetch; injectable for tests)
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Non-2xx response, classified. `code` is the engine's error.code, never its message. */
class PrologicHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly retryable: boolean,
    readonly details: unknown = undefined
  ) {
    super(`prologic_${operation}_http_${status}${code ? `:${code}` : ''}`);
    this.name = 'PrologicHttpError';
  }
}

/** 408/425/429/5xx are worth retrying; other 4xx will fail the same way again. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

interface RequestOptions {
  fetchFn: FetchLike;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

async function requestJson(
  options: RequestOptions,
  operation: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  idempotencyKey?: string
): Promise<unknown> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.apiKey}`,
    accept: 'application/json',
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;

  let response: Response;
  try {
    response = await options.fetchFn(`${options.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (cause) {
    // Network failure / timeout — retryable; keep messages PII-free.
    const reason = cause instanceof Error ? cause.name : 'unknown';
    throw new PrologicHttpError(operation, 0, `network_${reason}`, true);
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    const parsedError = prologicErrorBodySchema.safeParse(json);
    throw new PrologicHttpError(
      operation,
      response.status,
      parsedError.success ? parsedError.data.error.code : undefined,
      isRetryableStatus(response.status),
      parsedError.success ? parsedError.data.error.details : undefined
    );
  }
  return json;
}

// ---------------------------------------------------------------------------
// Reference catalog client (GET /v2/reference/scopes, cached in-process)
// ---------------------------------------------------------------------------

export interface PrologicReferenceClient {
  /**
   * Required tools per scope for the given scopes. Only scopes the catalog
   * KNOWS appear in the result — unknown scopes are omitted (the score call
   * remains the authority and answers 422 for genuinely bad requests).
   * Throws on transport failure (callers classify via {@link toFailedOutcome}).
   */
  requiredToolsForScopes(scopes: readonly string[]): Promise<Record<string, PrologicTool[]>>;
}

export interface PrologicReferenceClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  /** Catalog cache TTL (default 10 minutes). */
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Tolerant catalog extraction: the OpenAPI spec leaves the /reference/scopes
 * response shape open, so `{scopes: {...}}` wrappers, bare `{scope: entry}`
 * maps, and `[{scope, ...}]` arrays are all accepted; per-entry tool lists
 * are read from `required_tools` | `requiredTools` | `tools` and filtered to
 * the known tool enum. Unrecognized shapes yield an empty catalog (gating is
 * skipped; the engine's own 422 remains the backstop).
 */
export function parsePrologicScopeCatalog(payload: unknown): Record<string, PrologicTool[]> {
  const catalog: Record<string, PrologicTool[]> = {};

  const readTools = (entry: unknown): PrologicTool[] | null => {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const list = record['required_tools'] ?? record['requiredTools'] ?? record['tools'];
    if (!Array.isArray(list)) return null;
    const tools: PrologicTool[] = [];
    for (const item of list) {
      const parsed = prologicToolSchema.safeParse(item);
      if (parsed.success) tools.push(parsed.data);
    }
    return tools;
  };

  const root =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? ((payload as Record<string, unknown>)['scopes'] ?? payload)
      : payload;

  if (Array.isArray(root)) {
    for (const entry of root) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const scope = record['scope'] ?? record['id'] ?? record['key'];
      const tools = readTools(entry);
      if (typeof scope === 'string' && scope.length > 0 && tools !== null) {
        catalog[scope] = tools;
      }
    }
    return catalog;
  }

  if (typeof root === 'object' && root !== null) {
    for (const [scope, entry] of Object.entries(root)) {
      const tools = readTools(entry);
      if (tools !== null) catalog[scope] = tools;
    }
  }
  return catalog;
}

export function createPrologicReferenceClient(
  options: PrologicReferenceClientOptions
): PrologicReferenceClient {
  const baseUrl = (options.baseUrl ?? PROLOGIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const ttlMs = options.ttlMs ?? DEFAULT_REFERENCE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000;
  const now = options.now ?? Date.now;

  let cache: { catalog: Record<string, PrologicTool[]>; fetchedAt: number } | null = null;

  return {
    async requiredToolsForScopes(scopes) {
      if (!cache || now() - cache.fetchedAt >= ttlMs) {
        const payload = await requestJson(
          { fetchFn, baseUrl, apiKey: options.apiKey, timeoutMs },
          'reference_scopes',
          'GET',
          '/v2/reference/scopes'
        );
        cache = { catalog: parsePrologicScopeCatalog(payload), fetchedAt: now() };
      }
      const out: Record<string, PrologicTool[]> = {};
      for (const scope of scopes) {
        const tools = cache.catalog[scope];
        if (tools !== undefined) out[scope] = tools;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface PrologicScoringAdapterOptions {
  /** API key (Bearer) — from env (PROLOGIC_API_KEY) at the composition root. */
  apiKey: string;
  /** Engine base URL (PROLOGIC_API_URL); defaults to production. */
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: FetchLike;
  /** Injectable reference-catalog client (defaults to a cached one). */
  reference?: PrologicReferenceClient;
  referenceTtlMs?: number;
}

function toFailedOutcome(
  cause: unknown,
  fallbackOperation: string,
  externalRef?: ScoringExternalRef
): Extract<ScoringOutcome, { kind: 'failed' }> {
  if (cause instanceof PrologicHttpError) {
    return {
      kind: 'failed',
      retryable: cause.retryable,
      error: cause.message,
      ...(externalRef ? { externalRef } : {}),
    };
  }
  const reason = cause instanceof Error ? cause.name : 'unknown';
  return {
    kind: 'failed',
    retryable: true,
    error: `prologic_${fallbackOperation}_error:${reason}`,
    ...(externalRef ? { externalRef } : {}),
  };
}

/** `pt-BR` → `pt`; must land in the registration enum (en|fr|pt). */
function normalizeLanguage(tag: string | undefined): 'en' | 'fr' | 'pt' | null {
  if (!tag) return null;
  const primary = tag.trim().toLowerCase().split('-')[0] ?? '';
  const parsed = registrationLanguageSchema.safeParse(primary);
  return parsed.success ? parsed.data : null;
}

function identityComplete(
  respondent: ScoringRespondentIdentity | undefined
): respondent is ScoringRespondentIdentity {
  return (
    respondent !== undefined &&
    respondent.id.length > 0 &&
    respondent.firstname.length > 0 &&
    respondent.lastname.length > 0 &&
    respondent.email.length > 0
  );
}

/** Compact PII-free summary of a tool 422: `q3:range,q7:required`. */
function summarizeToolIssues(details: unknown): string {
  if (!Array.isArray(details)) return '';
  const parts: string[] = [];
  for (const item of details.slice(0, 10)) {
    const parsed = prologicToolIssueSchema.safeParse(item);
    if (!parsed.success) continue;
    const q = parsed.data.q !== undefined ? `q${parsed.data.q}` : 'q?';
    parts.push(`${q}:${parsed.data.rule ?? 'invalid'}`);
  }
  return parts.join(',');
}

export function createPrologicScoringAdapter(
  options: PrologicScoringAdapterOptions
): ScoringAdapter {
  const baseUrl = (options.baseUrl ?? PROLOGIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const reference =
    options.reference ??
    createPrologicReferenceClient({
      apiKey: options.apiKey,
      baseUrl,
      fetchFn,
      ...(options.referenceTtlMs !== undefined ? { ttlMs: options.referenceTtlMs } : {}),
    });

  return {
    mode: 'async_external',

    async score(input: ScoringInput): Promise<ScoringOutcome> {
      // -- Config (Zod at the boundary; product CRUD validated it already) --
      const config = prologicRuntimeConfigSchema.safeParse(input.config);
      if (!config.success) {
        const paths = config.error.issues.map((i) => i.path.join('.') || '(root)').join(',');
        return { kind: 'failed', retryable: false, error: `prologic_config_invalid:${paths}` };
      }
      const { accessCode, scopes, toolMap, norms, timeoutSeconds } = config.data;
      const timeoutMs = timeoutSeconds * 1000;
      const http: RequestOptions = { fetchFn, baseUrl, apiKey: options.apiKey, timeoutMs };

      // -- Respondent identity (payload-contract PII exception) --
      const respondent = input.respondent;
      if (!identityComplete(respondent)) {
        // The service only populates identity when the config names a
        // provider; a gap here means missing respondent data (never include
        // WHICH field beyond its name — no values).
        return { kind: 'failed', retryable: false, error: 'prologic_respondent_identity_missing' };
      }
      const language = normalizeLanguage(input.respondentMeta?.language);
      if (language === null) {
        return {
          kind: 'failed',
          retryable: false,
          error: 'prologic_unsupported_language',
        };
      }

      // -- Map answers → per-tool responses --
      const toolResponses = buildPrologicToolResponses(input.answers, toolMap);
      const availableTools = Object.keys(toolResponses) as PrologicTool[];
      if (availableTools.length === 0) {
        return { kind: 'failed', retryable: false, error: 'prologic_no_mappable_answers' };
      }

      // -- Reference-catalog gating: required tools per configured scope --
      try {
        const required = await reference.requiredToolsForScopes(scopes);
        const missing: string[] = [];
        for (const [scope, tools] of Object.entries(required)) {
          for (const tool of tools) {
            if (!availableTools.includes(tool)) missing.push(`${scope}:${tool}`);
          }
        }
        if (missing.length > 0) {
          return {
            kind: 'failed',
            retryable: false,
            error: `prologic_missing_tools:${[...new Set(missing)].sort().join(',')}`,
          };
        }
      } catch (cause) {
        return toFailedOutcome(cause, 'reference_scopes');
      }

      // -- Register (idempotent per respondent+session) --
      let externalRef: ScoringExternalRef;
      try {
        const created = await requestJson(
          http,
          'register',
          'POST',
          '/v2/assessments',
          {
            firstname: respondent.firstname,
            ...(respondent.middlename !== undefined ? { middlename: respondent.middlename } : {}),
            lastname: respondent.lastname,
            email: respondent.email,
            language,
            gender: respondent.gender ?? null,
            // BILLING-CRITICAL: respondents.id, stable across orders/rescores.
            external_id: respondent.id,
          },
          prologicRegistrationIdempotencyKey(respondent.id, input.sessionId)
        );
        const status = prologicAssessmentStatusSchema.safeParse(created);
        if (!status.success) {
          return { kind: 'failed', retryable: false, error: 'prologic_register_response_invalid' };
        }
        externalRef = { provider: PROLOGIC_PROVIDER, assessmentId: status.data.assessment_id };
      } catch (cause) {
        return toFailedOutcome(cause, 'register');
      }

      // -- Submit each mapped tool (PUT replaces; inherently idempotent) --
      for (const tool of availableTools) {
        try {
          await requestJson(http, `tool_${tool}`, 'PUT', `/v2/assessments/${externalRef.assessmentId}/tools/${tool}`, {
            responses: toolResponses[tool],
          });
        } catch (cause) {
          if (cause instanceof PrologicHttpError && cause.status === 422) {
            const summary = summarizeToolIssues(cause.details);
            return {
              kind: 'failed',
              retryable: false,
              error: `prologic_tool_rejected:${tool}${summary ? `:${summary}` : ''}`,
              externalRef,
            };
          }
          return toFailedOutcome(cause, `tool_${tool}`, externalRef);
        }
      }

      // -- Score (synchronous) --
      try {
        const scored = await requestJson(
          http,
          'score',
          'POST',
          `/v2/assessments/${externalRef.assessmentId}/score`,
          {
            scopes,
            format: 'keys',
            access_code: accessCode,
            audit: false,
            ...(norms !== undefined ? { norms } : {}),
          },
          prologicScoreIdempotencyKey(input.jobId)
        );
        const envelope = prologicResultEnvelopeSchema.safeParse(scored);
        if (!envelope.success) {
          return {
            kind: 'failed',
            retryable: false,
            error: 'prologic_score_response_invalid',
            externalRef,
          };
        }
        return {
          kind: 'sync_result',
          scores: normalizePrologicEnvelope(envelope.data),
          externalRef,
        };
      } catch (cause) {
        if (cause instanceof PrologicHttpError && cause.status === 403) {
          // Access-code problem: unknown/unusable code or scopes outside its
          // allowance — a config problem, retrying cannot help.
          return {
            kind: 'failed',
            retryable: false,
            error: `prologic_access_code_rejected${cause.code ? `:${cause.code}` : ''}`,
            externalRef,
          };
        }
        if (cause instanceof PrologicHttpError && cause.status === 422) {
          // Missing tools per scope / unknown scope / norm-set problem.
          return {
            kind: 'failed',
            retryable: false,
            error: `prologic_score_rejected${cause.code ? `:${cause.code}` : ''}`,
            externalRef,
          };
        }
        return toFailedOutcome(cause, 'score', externalRef);
      }
    },
  };
}
