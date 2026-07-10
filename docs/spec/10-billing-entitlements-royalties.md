# 10 — Billing, Entitlements, Royalties & Xero

Plans are **per client × product** — a client may simultaneously be prepay for PRO-D and post-pay for KnowingMe. Retail orders have no plan (standalone Stripe transactions).

## Plan types

| plan_type | Unit | Enforcement | Invoicing |
|---|---|---|---|
| `prepay_credits` | credits (1 order line = N credits, N per product config; default 1 per respondent session) | **hard block** at zero balance; super_admin may override (audited) | invoice at purchase, push to Xero |
| `seat_licence` | named seats for a period | block when seats exhausted or period expired | invoice at purchase |
| `flat_access` | unlimited within period | block outside period | invoice at purchase |
| `postpay` | metered usage | no block (optional credit-limit config later) | cycle-end usage invoice (daily/weekly/monthly per client) |
| batch codes | the code pool IS the entitlement | codes single-use | invoice at pool purchase |

## Entitlement mechanics

- Order submission (`draft → pending`) **reserves** entitlement: in one transaction, `SELECT ... FOR UPDATE` the entitlement row, check `balance ≥ needed`, append `entitlement_ledger` usage entry, update cached balance, attach `orders.entitlement_id`. Cancellation before completion appends a compensating `adjustment` entry.
- Ledger is append-only (`purchase`/`usage`/`adjustment`/`expiry`/`refund`); balance is derivable; nightly job verifies cache = Σ deltas and alerts on drift.
- Low-balance warning: when balance crosses `low_balance_threshold`, notify client admin + super admin (once per crossing).
- Post-pay metering: each approved order appends usage; cycle-close job (BullMQ repeatable) groups un-invoiced usage per client per cycle → creates invoice → pushes to Xero → marks ledger entries with `invoice_id`.

## Invoicing adapter (Xero behind an interface)

```ts
interface InvoicingAdapter {
  createInvoice(inv: { reference: string; contact: {xeroContactId?: string; name; email}; currency;
                       lines: {description; qty; unitAmountMinor; accountCode?; trackingCode?}[];
                       dueDate?: string; status: 'draft'|'authorised' }): Promise<{ externalId: string }>;
  markPaid?(externalId: string, paidAt: string): Promise<void>;
}
```

- The platform is the invoice source of record: it generates the invoice (`invoices` table + PDF/email to client) and pushes a copy to Xero. `invoices.reference` (`INV-YYMM-#####`) is written to Xero's reference field. Product `tracking_code` (legacy Xero item codes) carried per line.
- **Stripe reconciliation**: repeatable job batches succeeded Stripe payments by payout period → creates one Xero invoice/journal per payout so Xero matches Stripe deposits (mirrors legacy `xero_invoices`/`xero_journals` crons).
- Xero OAuth2 tokens in `platform_settings` (encrypted values via env-provided key); adapter refreshes tokens itself. Xero outages: queue + retry with backoff; invoices stay `pushed_to_xero_at IS NULL` and visible in an admin "pending Xero" list.

## Royalties (distinct from Stripe Connect)

Royalty = contractual obligation to a product's owner/licensor; Connect = one possible settlement rail.

- `products.royalty_policy`: `{ method: 'pct_net_revenue'|'fixed_per_completion'|'hybrid', pctNet?, fixedAmountMinor?, hybrid?: {fixedUpTo: n, thenPct}, settlement: 'stripe_connect'|'platform_invoice'|'manual', period: 'monthly'|'quarterly'|'per_order' }`.
- On order `completed` (per completed session for per-completion methods): compute obligation, append `royalty_ledger` (product, order, session, basis, amount, period key). `is_test` orders excluded. Refunds append negative entries.
- Settlement: admin generates a statement per product × period → `royalty_settlements` row + exportable statement (units, basis, gross/net, amounts, external IDs from `products.external_ids`) → mark settled (manual/invoice) or trigger Stripe Connect transfer (phase 2). Assessment admins see their own product's statements read-only.

## Stripe Connect

- `products.connected_stripe_account_id` + `revenue_split_pct` exist from day one so attribution is correct historically; automated `transfer` calls (destination charges are NOT used — separate transfers after platform capture) ship in phase 2.
- Platform operates a Stripe Connect platform account; onboarding an owner = Stripe-hosted Express onboarding link from the product admin page.

## Refunds

Admin refund on a completed order: provider refund via Payment adapter → on success order `refunded`, negative royalty entry, entitlement `refund` entry if it was credit-paid, audit. Partial refunds keep the order `completed` with a `partially_refunded` payment.
