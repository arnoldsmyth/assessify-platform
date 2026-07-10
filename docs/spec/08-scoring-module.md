# 08 — Scoring Engine Module

Scoring is decoupled behind an adapter. Each product's `scoring_config` selects an engine and mode. Raw responses are **always persisted in Firestore before dispatch** so re-scoring never re-runs a questionnaire.

## Adapter interface

```ts
interface ScoringAdapter {
  // Called by the worker processing a 'scoring.dispatch' job
  score(input: ScoringInput): Promise<ScoringOutcome>;
}
type ScoringInput = {
  jobId: string; sessionId: string;
  product: { id: string; externalIds: Record<string,string> };
  questionnaire: { key: string; version: number; variant: string };
  answers: Record<string, AnswerValue>;      // visible answers only, option keys / numbers — NO PII
  respondentMeta?: { language: string; gender?: string };  // only fields the engine contract requires, documented per product
  callback?: { url: string; token: string }; // async mode only
};
type ScoringOutcome =
  | { kind: 'sync_result'; scores: ScoreSet }
  | { kind: 'accepted_async' }                // engine will POST to callback later
  | { kind: 'failed'; retryable: boolean; error: string };
type ScoreSet = {
  dimensions: Record<string, number>;         // e.g. { drive: 72.5, ... }
  bands?: Record<string, string>;             // dimension -> band label key
  percentiles?: Record<string, number>;
  narrativeKeys?: string[];                   // keys into report narrative blocks
  raw?: unknown;                              // engine-native payload, stored verbatim
};
```

`products.scoring_config` (jsonb): `{ mode: 'sync_internal'|'async_external', engineKey?: 'pro-d-v1'|..., endpoint?: url, auth?: {type:'api_key'|'hmac'|'oauth2', secretRef: string}, timeoutSeconds, maxAttempts, payloadMapping?: {...} }`. Secrets are referenced by env-var name (`secretRef`), never stored in the DB.

## Flow

```
session completed
  └▶ scoringService.dispatch(sessionId)
       ├─ create scoring_jobs row (status 'queued'), enqueue BullMQ 'scoring.dispatch'
       └▶ worker: load answers from Firestore, build ScoringInput, call adapter
            ├─ sync_result  → scoringService.applyScores() → session 'scored' → reportService.assemble (09)
            ├─ accepted_async → job 'awaiting_callback' ; session 'awaiting_scores'
            └─ failed → retry w/ backoff up to maxAttempts → order 'scoring_error' + admin alert
```

### Async callback contract (external engines)

- Dispatch includes `callback.url = https://app.assessify.ie/api/webhooks/scoring/{jobId}` and a random 256-bit `callback.token`. Only an HMAC-SHA256 **hash** of the token is stored (`scoring_jobs.callback_token_hash`).
- External engine POSTs: `Authorization: Bearer {token}`, body `{ jobId, status: 'scored'|'failed', scores?: ScoreSet, error?: string }`.
- Handler (API route → scoring adapter parse/verify → service): verify token hash matches the job, job is `awaiting_callback` (replays are idempotent no-ops returning 200), payload validates against Zod schema. Then `applyScores()` or fail-path as above. Invalid token → 404 (not 401 — don't confirm job existence).
- Delay tolerance: seconds to hours. A repeatable watchdog job flags jobs `awaiting_callback` older than a per-product SLA (default 24h) → order `scoring_error`.
- HTTPS only. The legacy TAI integration ran over plain HTTP — the new wrapper for that engine must terminate TLS or be replaced.

## applyScores (service)

1. Validate `ScoreSet` (Zod). 2. Write `respondent_sessions.scores`, `scored_at`, status `scored`. 3. Mark scoring_job `completed`. 4. Audit event. 5. Kick `report.assemble` job (`09`). All in one Postgres transaction except the queue enqueue (enqueue after commit).

## Re-scoring

Admin action (super_admin only): creates a **new** scoring_job for a session; on success overwrites `scores` (previous value preserved in the audit event detail). Available for any completed session because raw answers are immutable in Firestore.

## Internal engines (`sync_internal`)

Platform-owned scoring functions live in `packages/adapters/scoring/engines/{engineKey}.ts` — pure functions `(answers, definition) => ScoreSet` with exhaustive unit tests against fixture answer sets. The PRO-D engine (if brought in-house rather than wrapping the external service) is one of these; keep the external wrapper as fallback until parity is proven against historical scored data.
