# 12 — External API (partners / machine-to-machine)

Versioned REST under `/api/v1/`, OpenAPI spec auto-generated from the Zod schemas (zod-openapi) and served at `/api/v1/docs`. Phase 2 feature, but webhook/scoring-callback routes ship earlier (phase 1) on the same conventions.

## Auth

- `Authorization: Bearer ak_live_...` — random 256-bit secrets, shown once at creation, stored as SHA-256 (`api_keys.key_hash`), `key_prefix` retained for display.
- Keys scoped to a client and/or product with `scopes`: `orders:write`, `orders:read`, `results:read`, `webhooks:manage`. Every request re-checks scope + tenant match (a key scoped to client X can never read client Y's order even with a valid UUID).
- Rate limit per key (Valkey token bucket, default 120 req/min) → 429 with `Retry-After`.
- `api_keys.last_used_at` updated (throttled); revocation immediate.

## Endpoints (v1)

| Method + path | Purpose |
|---|---|
| `POST /api/v1/orders` | Place an order. Body: `{ productId, type: 'named'|'bulk_named'|'batch_code', respondents?: [{firstName,lastName,email,language?}], codeCount?, reportLanguage?, suppressNotifications?, metadata? }` → 201 `{ orderId, reference, sessions: [{sessionId, respondentEmail, assessmentUrl?}] }`. `suppressNotifications: true` (legacy silent mode) returns `assessmentUrl` per session and sends no email — partner delivers invitations |
| `GET /api/v1/orders/{orderId}` | Order + session statuses |
| `GET /api/v1/orders?status=&from=&to=&cursor=` | List (cursor pagination) |
| `GET /api/v1/sessions/{sessionId}` | Session status, completion timestamps |
| `GET /api/v1/sessions/{sessionId}/results` | ScoreSet (requires `results:read`), 409 until scored |
| `POST /api/v1/sessions/{sessionId}/report-link` | Mint a time-limited signed report URL `{ expiresInHours ≤ 720 }` → `{ url, expiresAt }` |
| `POST /api/v1/webhook-subscriptions` / `GET` / `DELETE /{id}` | Manage subscriptions (`webhooks:manage`) |
| `POST /api/webhooks/scoring/{jobId}` | (Unversioned infra route) inbound scoring callback — bearer token per job, see `08` |

Conventions: JSON only; errors `{ error: { code, message, details? } }` with stable machine `code`s; UUIDs in paths; `Idempotency-Key` header honoured on POST /orders (stored 24h in Valkey; replay returns the original response); all timestamps ISO-8601 UTC.

## Outbound webhooks (partner subscriptions)

- Events: `order.approved`, `order.sent`, `session.completed`, `session.scored`, `report.ready`, `order.completed`, `order.cancelled`, `code.redeemed`.
- Delivery: BullMQ job per event × subscription → POST `{ id, event, createdAt, data }` with headers `X-Assessify-Signature: t=<ts>,v1=<hmac-sha256(secret, ts + '.' + body)>` (Stripe-style, replay window 5 min).
- Retry: exponential backoff 1m/5m/30m/2h/6h (5 attempts) → mark `failed`; admin UI lists failures with manual redeliver. Auto-disable a subscription after 50 consecutive failures (notify key owner).
- `webhook_deliveries` keeps payload + status + attempts (legacy `tbl_outboundwebhooks` equivalent).
