# 06 — Orders & State Machine

An order binds a client (or retail purchaser), a payment route, one product, and one or more respondent sessions. `orders.type` selects the fulfilment flow; all types share the same state machine.

## Order models

| type | Respondents | Tokens | Report(s) | Phase |
|---|---|---|---|---|
| `named` | 1, known | 1 session token + PIN | 1 individual | 1 |
| `bulk_named` | N, known | N session tokens + PINs, invitable in batches | N individual | 1 |
| `multi_rater` | 1 focal + N raters (typed relationships) | token+PIN each; raters get rater-variant questionnaire | 1 aggregated 360 report | 1.5 |
| `group` | unknown, self-register via shared link | 1 group token + shared PIN | per `report_model`: individual / aggregate / both | 1.5 |
| `retail` | 1, from Stripe Checkout | 1 session token + PIN | 1 individual | 1.5 |
| `batch_code` | unknown, redeem codes | N single-use codes | individual per redemption | 1.5 |

## State machine (single source of truth)

```
draft ──submit──▶ pending ──payment ok──▶ approved ──invites sent──▶ sent
                     │                        │
                     │payment fails           │email fails
                     ▼                        ▼
               payment_error ──retry──▶ (pending)      email_error ──retry──▶ (approved)
sent ──all focal sessions completed──▶ processing_report ──scores+reports ready──▶ completed
processing_report ──engine failure──▶ scoring_error ──retry──▶ (processing_report)
any non-terminal ──admin──▶ on_hold ──admin──▶ (previous state)
draft|pending|approved|sent ──admin──▶ cancelled
completed ──admin refund──▶ refunded
completed ──admin──▶ resend_email ──auto──▶ completed        (transient trigger state)
```

Normative transition table (service rejects anything not listed):

| From | To | Trigger |
|---|---|---|
| draft | pending | submit (validation + entitlement reserve) |
| pending | approved | payment succeeded / offline confirmed / entitlement drawn |
| pending | payment_error | payment failed |
| payment_error | pending | admin retry / new payment method |
| approved | sent | invitation dispatch succeeded (per-session invites; order is `sent` when ≥1 invite sent) |
| approved | email_error | invitation dispatch failed |
| email_error | approved | admin retry |
| sent | processing_report | completion rule met (below) |
| processing_report | completed | all expected reports `ready` |
| processing_report | scoring_error | scoring adapter failure/timeout |
| scoring_error | processing_report | admin retry |
| draft/pending/approved/sent | cancelled | admin |
| completed | refunded | admin (after provider refund succeeds) |
| completed | resend_email | admin resend trigger → auto-returns to completed |
| any non-terminal | on_hold | admin hold (store `previous_status` in `error_detail`) |
| on_hold | previous | admin release |

**Completion rule** per type: `named`/`retail`: the session completes. `bulk_named`: *per-session* — each session flows through scoring/report individually; order moves to `processing_report` when the **first** session completes and to `completed` when **all** sessions have reports ready (sessions carry their own `session_status` for granular UI). `multi_rater`: focal + minimum rater counts per product config met, or client admin forces early close. `group`: `expected_respondents` reached, expiry passed, or admin closes. `batch_code`: order is `sent` on code issuance; each redemption runs its own session lifecycle; order completes when all codes are redeemed+reported or expired (long-lived orders are normal here).

**Error states** (`payment_error`, `email_error`, `scoring_error`): populate `orders.error_detail`, create an admin alert (error queue UI + email to super admins), always retryable from admin UI. Every transition writes `audit_log` with actor.

## Order creation flows

### Admin/client wizard (server actions)
1. Choose client (super admin) → product → order type.
2. Type-specific step: named/bulk = respondent rows (first, last, email, language); multi_rater = focal + raters with relationship types; group = expected count, report model, expiry, cap; batch_code = code count + expiry.
3. Pricing step: unit price resolved as — client contracted price (`entitlements.unit_price` or client-product price config) → else product retail/list price. Per-line discount editable by super_admin only.
4. Payment step: entitlement draw-down (if active prepay entitlement covers it — see `10`) → else Stripe card / offline invoice.
5. Review → submit → `draft → pending → …` as above. Language for report chosen here (from product's `available_languages`).

### Retail (public product page)
`(public)` route on white-label host → Stripe Checkout Session (price from `products.retail_price`) → `checkout.session.completed` webhook → service creates: find-or-create respondent (by checkout email), order (type `retail`, client = platform retail client, status `approved` — payment already captured), session + token + PIN → invitation email → `sent`. Post-completion the report page offers optional account creation; linking sets `respondents.user_id`.

### Partner API
`POST /api/v1/orders` (see `12`) — like the wizard but `placed_via='api'`; supports `suppress_notifications` (silent mode: partner receives the token/URL and delivers invitations themselves).

## Payments (Payment Module)

Adapter interface (in `packages/adapters/payment`):

```ts
interface PaymentAdapter {
  createIntent(input: { amountMinor: number; currency: string; method: 'card'|'us_bank_account'|'offline';
                        customerRef?: string; metadata: { orderId: string } }): Promise<PaymentIntentResult>;
  refund(paymentId: string, amountMinor?: number): Promise<RefundResult>;
  parseWebhook(rawBody: Buffer, signature: string): Promise<PaymentEvent>;  // verify signature FIRST
}
```

- **Stripe adapter** (phase 1): card, immediate capture. Webhooks `payment_intent.succeeded|payment_failed`, `charge.refunded`, `checkout.session.completed` at `/api/webhooks/stripe` — verify signature, translate to `PaymentEvent`, hand to `paymentService.handleEvent()`. ACH (`us_bank_account`, phase 2): order stays `pending` until the delayed `payment_intent.succeeded`.
- **Offline adapter** (phase 1): no-op intent; order moves to `approved` immediately with an open invoice; admin marks invoice paid manually.
- **GoCardless adapter** (v2): implements the same interface; no service changes.

Idempotency: webhook handlers upsert `payments` by `provider_ref` and are safe to replay. All Stripe calls send idempotency keys derived from `orderId`.

## Pricing rules

- Stored on the order at creation (snapshot) — later price changes never affect existing orders.
- `total = Σ(order_items: quantity × unit_price − discount)`; currency fixed per order; mixed-currency orders are invalid.
- Volume tiers (legacy 13/25/50 bands) are expressed as **client contracted unit prices** maintained on the entitlement/client-product config — not runtime order-count checks. Migration maps legacy bands to contracted prices.
- `is_test` orders: full flow, excluded from all revenue/royalty/entitlement reporting (and from post-pay usage invoices).
