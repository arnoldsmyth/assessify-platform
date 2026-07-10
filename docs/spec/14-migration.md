# 14 — Legacy Data Migration

One-time, idempotent, scripted import (`scripts/migrate-legacy/`) from a MySQL dump of `produsr_app` (schema: `../schema-produsr_app.sql`, semantics: `../schema-companion.md`) into the new model. Runs via the Repository layer with service business rules bypassed where historical integrity requires (documented per step). **Not a UI feature.** Phase 2 (pull earlier if cutover demands).

## Principles

- Idempotent: every writer upserts on `(source='legacy', legacy_id)`; re-runs create nothing new.
- Traceable: all imported rows get `source='legacy'` + `legacy_id` (stringified legacy PK).
- No re-scoring, no re-sending: imported orders land in terminal states with notifications suppressed.
- Dry-run mode prints counts + anomaly report (unmapped statuses, orphan FKs, duplicate emails) before writing.

## Mapping

| Legacy | New | Notes |
|---|---|---|
| `users` (owners) | `clients` + Better Auth user + `role_assignments(client_admin)` | Each legacy "owner" (coach) becomes a client org named after them, with themselves as client_admin. Admin-group members (`opt_groups.is_admin/is_master_admin` via `tbl_group_members`) → `super_admin`/staff roles — reviewed list, not automatic |
| `tbl_customers` (~14.5k) | `respondents` | dedupe by lowercased email (multiple legacy customer rows with one email → one respondent; keep mapping table for order linkage). `language_id` → BCP47 via `opt_languages` (`en-ca`→`en-CA` style) |
| `opt_products` | `products` (+ per-product decision log) | Only currently-sellable products become active; retired ones import as `status='retired'` for order history integrity. `tracking_code` → kept for Xero lines; `available_languages` split; discount/rebate columns recorded in the decision log, not auto-converted |
| `tbl_orders` (~15.4k) | `orders` + `order_items` + `respondent_sessions` | One legacy order = one order + one session. Money: legacy decimals × 100 → minor units. `assessment_link_code` → stored in session `legacy_id` metadata (legacy links may redirect, below). `batch_id` groups orders → shared `client_groups` entry per batch where meaningful + invoice linkage |
| legacy `order_status_id` | `orders.status` | 1→`draft`, 2→`pending`, 3→`approved`, 4→`sent`, 5→`processing_report`, 6→`completed`, 7→`cancelled`, 8→`on_hold`, 11→`on_hold`, 12→`completed` (re-notify is transient), 13→`scoring_error`; unknown 9/10 → `on_hold` + anomaly report. `test_order=1` → `is_test=true` |
| `tbl_order_activity` (~400k) | `audit_log` | actor_type `system`, action `legacy.<action>` |
| `tbl_transactions` | `payments` | best-effort provider refs |
| `tbl_projects` / `tbl_project_orders` | `client_groups` (kind `project`) + `order_group_links` | |
| `tbl_purchase_codes` | `redemption_codes` under synthetic `batch_code` orders | preserve redeemed status |
| `tbl_commission`, rebate fields | decision log + optional `royalty_ledger` seed | rebate history is reported from legacy data, not re-computed |
| `tbl_translation` | `translation_strings` | keyed per product where attributable |
| `opt_webhook_settings` | `webhook_subscriptions` (inactive until owner re-confirms) | secrets regenerated — never carry legacy keys |
| `tbl_qst_responses` / Firebase RTDB export | Firestore `responses/{sessionId}` | best-effort answer-shape mapping per question type; unmappable → stored as `raw_legacy` blob on the doc |
| Report PDFs (Cloudfiles/Firebase) | Firebase Storage `legacy-reports/{legacy_order_id}/...` + `reports.legacy_pdf_path` | separate file-copy step with checksum manifest; `reports.status='released'` |

## Legacy link continuity

Old assessment/report URLs embed the ALC. If the old domain (`app.pro-d.com`) is pointed at Assessify post-cutover, a catch-all route looks up sessions by legacy ALC and: completed → redirect to token+PIN report access (send fresh PIN email on demand); incomplete legacy orders at cutover are handled by policy (recommend: re-issue as new Assessify invitations rather than supporting legacy in-flight state).

## Cutover sequence (recommended)

1. Freeze legacy order creation → final MySQL dump + Firebase export + PDF sync.
2. Run migration dry-run → review anomalies → run live → verify counts (orders, sessions, respondents, PDFs by checksum).
3. Spot-check: N random legacy reports downloadable; N random respondent histories correct.
4. DNS: point legacy hostnames per `11`; enable redirect route.
5. Keep the legacy DB read-only for 12 months as reference.
