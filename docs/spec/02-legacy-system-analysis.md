# 02 — Legacy System Analysis

Survey of the production PRO-D codebase (`PRO-D-Production-2024`, deployed as manage.pro-d.com + app.pro-d.com). This document exists so the rebuild carries forward the **behaviour** that matters and consciously drops the rest. File references point into the legacy repo.

## Architecture found

Two-tier: **AngularJS 1.x admin SPA** (repo root: `app.js`, `views/`, `services/`, `config/routes.js`) + **CodeIgniter 3 PHP backend** (`api/application/`). Three overlapping data stores:

1. **MySQL** `produsr_app` — 26 tables, 26 views (see `../schema-produsr_app.sql` and `../schema-companion.md`)
2. **Firebase Realtime DB** (`pro-d.firebaseio.com`) — live questionnaire state; answers double-written to MySQL and Firebase
3. **Backand** (BaaS, company defunct) — frontend auth + generic CRUD. Hard dependency; a key reason the rebuild is unavoidable.

The questionnaire exists **twice**: a server-rendered PHP version (production: `api/application/controllers/Questionnaire.php` + `views/questionnaire/page/p01…p12.php`) and an incomplete AngularJS copy. The PHP version is authoritative.

## The legacy assessment loop (behaviour to preserve, mechanism to replace)

1. Order created (admin SPA or **Cognito Forms** website order → `M_orders::create_from_cognito`), generating an `assessment_link_code` (ALC) — the ancestor of Assessify's respondent token.
2. Cron `Sendassessmentemail.php` emails the respondent their assessment link (localised templates en-US/en/fr-FR/pt-BR), with auto-retry for failures.
3. Respondent takes the assessment at `Take::assessment($alc)`; `verify_alc()` validates; progress tracked in Firebase; answers saved to Firebase + MySQL; language switchable mid-questionnaire (cookie).
4. On completion → status 4; cron `Submitforscoring.php` POSTs the response payload to the external **TAI scoring service** (`http://a.taiinc.com/TAIWebService/TAIWS.svc/register` — plain HTTP!) → status 5; failures → status 13.
5. `Generatereport.php` (142 KB single controller) builds an HTML report from one of **18+ template variants** (`core`, `advance`, `premium`, `student`, `teacher`, `hr`, `marriage`, `faithbased`, `homeschool`, `kmcareer`, `kmscholar`, `advisor`, `equip`, `graphonly`, `preemployment`…) and POSTs it to **DocRaptor** (Prince, paged CSS, per-doc fee) with async callback `Pdfcallback::docraptor()`; DocRaptor jobs tracked in `tbl_docraptor_transactions`.
6. Finished PDF stored (Rackspace "Cloudfiles"/Firebase), report-ready email sent, download served by `Downloadfile::request($alc, $file, $format, $language_id)` (multi-file/language zips).

**Rebuild mapping:** ALC → respondent session token + PIN; crons → BullMQ jobs; TAI call → Scoring Engine Module (async external adapter, HTTPS + signed callback); DocRaptor → WeasyPrint service (same paged-CSS model — templates are static HTML/CSS with **no JS at render time**, which the legacy templates already prove works); Cloudfiles → Firebase Storage (legacy PDFs only; new PDFs are generated on demand, never stored).

## Business rules extracted from code

These are behaviours buried in PHP that must become **configuration** in Assessify:

- **Volume discounts** — `M_orders::calculate_vol_discount()`: each user carries a discount band (1–4); each product has `volume_discount_1..4` rates; subtotal = `(flat_fee + (price − price×discount)) − previous_subtotals`. Bands refreshed by `Maintenance::update_discounts()` from 13/25/50-order tiers. → Assessify: per-client contracted unit prices + per-line discounts (`06`), volume tiering as client pricing config, not user-state.
- **Rebates (distributor margin)** — `M_orders::get_rebate()` hardcodes: price 30–39 → rebate `39 − price`; 29 → 9; 25–28 → 8; 22–24 → 7; else 0. → becomes explicit royalty/commission policy records (`10`).
- **Payment precedence** — `Chargeandapprove.php`: purchase credits → money credits → card/invoice. → entitlement draw-down then payment module (`06`, `10`).
- **Upgrades** — `type='upgrade'`, `related_order_id`, `free_upgrade`, `upgrade_flat_fee` (default $5), dedicated upgrade email set. → out of v1 scope; schema keeps `orders.related_order_id` so history imports cleanly.
- **Order statuses** — 13 rows in `opt_order_status`; key transitions: >2 = active, 6 = completed/billable, 7 = cancelled (excluded everywhere), 3/12 trigger notification emails, `order_edit_allowed` gates editing. → the explicit state machine in `06` is a cleaned-up superset.
- **Test orders** — `test_order = 1` excluded from all revenue reporting. Keep: `orders.is_test`.
- **Silent mode** — API-created orders with `silent_mode = 1` send no emails, only return the ALC (partners deliver invitations themselves). Keep: order-level `suppress_notifications` flag; partner API depends on it (`12`).
- **Per-user/product outbound webhooks** — `opt_webhook_settings` + `tbl_outboundwebhooks` (payload log, HTTP status, fail count). Keep: webhook subscriptions + delivery log (`12`).
- **Email event tracking** — Mailgun + SendGrid event webhooks update order email status. Keep: SendGrid event webhook → `notification_log` (`13`).
- **Idle logout** — 1-hour idle timeout with 30s warning in the admin SPA. Preserve as a session policy.
- **Two brands, two Stripe accounts** — "KM" (`-km` templates, `km-google` sender) and a second Stripe merchant ("Whispering Pines", `libraries/Stripewhisperingpines.php`). Proof multi-product/multi-merchant is a real requirement, not speculative — in Assessify this is products + Stripe Connect (`10`).
- **Sponsorship charging** (`Sponsorship.php`) — third party pays for someone else's assessment. Covered by the ordinary client-pays-for-respondent model.

## Integrations inventory (legacy → decision)

| Legacy | Purpose | Rebuild decision |
|---|---|---|
| Backand | Auth + CRUD BaaS | **Drop** (defunct). Replaced by own Postgres + auth |
| Stripe ×2 accounts | Cards | **Keep** — Payment Module, Stripe adapter; multi-merchant via Connect |
| Firebase RTDB | Live questionnaire state | **Replace** with Firestore (response docs + progress) |
| DocRaptor | HTML→PDF | **Replace** with WeasyPrint service |
| TAI (a.taiinc.com) | External scoring | **Replace/wrap** as async external scoring adapter over HTTPS |
| Cognito Forms | Website order intake (form IDs 2, 21) | **Drop** — native product pages + Stripe Checkout |
| Xero | Invoices + journals + payout reconciliation | **Keep** — invoicing adapter (`10`) |
| Mailgun + SendGrid + 2× DO-serverless Google SMTP | Email | **Consolidate** to Mailer adapter, SendGrid backend |
| Zapier hook (`M_orders::post_to_zapier`) | Order events | **Superseded** by webhook subscriptions |
| Intercom | Support chat + events | Optional later; not specced |
| Rackspace Cloudfiles | Report file storage | **Replace** with Firebase Storage (legacy PDFs) |
| Google Data Studio (`vw_orders_for_datastudio`) | BI | Later: read replica / export endpoint; `ComprehensiveSalesReport` features fold into admin reporting |

## Security debt (do not repeat)

- Live **Stripe secret keys** (both merchants) committed in `api/application/libraries/Stripe.php` / `Stripewhisperingpines.php`; publishable key in `config/consts.js`; **Firebase secret**, **Mailgun/SendGrid keys**, **Backand tokens** all committed. `FileZilla.xml` (likely FTP credentials) at repo root. **Action outside this project: rotate all of these.**
- One static shared API key for the whole SPA API (`M_endpoint::auth_check`); a second reporting key passed **in URLs** and embedded in the committed client-side `sales_report_interface.html` — effectively public.
- Scoring payloads over plain HTTP.
- Assessify counters: per-principal API keys (hashed, scoped), session auth for the SPA, HTTPS-only, HMAC-signed scoring callbacks, secrets in DO App Platform config.

## Data worth migrating (see 14-migration.md)

~14.5k customers (`tbl_customers`), ~15.4k orders (`tbl_orders`), order activity audit (~400k rows), transactions, projects/purchase codes, users, translations, and stored legacy report PDFs. Views encode reporting semantics (status >2 active, ≠7, `test_order` exclusion) that the migration must honour when mapping states.

## Deliberately not carried forward

Dead/duplicate files (`OLD-*`, `home-2017-*`, test controllers), the Angular questionnaire copy, Backand entirely, Cognito Forms coupling, hardcoded rebate/discount magic numbers (become config), the 142 KB god-controller pattern (becomes services), per-report-type PHP template sprawl (becomes one versioned React template per product with a data-driven config).
