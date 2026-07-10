# 16 — Backlog (mirrors the beads database)

The live backlog is a **beads** database initialised in the `assessify-platform` folder (`.beads/`). When the real repo is created, move it with the code (or `bd export` / `bd import`). Run `bd ready` to see unblocked work; `bd show <id>` for details. Every issue's description references the spec docs that define it — build agents implement from the spec, not from the issue title.

Priorities: P0 = foundations (nothing works without it), P1 = MVP (phase 1), P2 = phase 1.5, P3 = phase 2. Labels carry the phase.

Beads epic IDs (created 2026-07-10): A=`asy-aq5` B=`asy-ow0` C=`asy-7jx` D=`asy-5h7` E=`asy-izb` F=`asy-5sa` G=`asy-2ag` H=`asy-fii` I=`asy-5wl` J=`asy-0lr` K=`asy-rr3` L=`asy-389`. Task IDs are children of these — `bd show <epic-id>` lists them.

## Epic A — Foundations & platform shell (P0, phase-1)
| Issue | Spec | Depends on |
|---|---|---|
| A1 Monorepo scaffold: pnpm+turborepo, Next.js, worker, packages, CI, layer-boundary lint | 03 | — |
| A2 Drizzle schema + initial migration: full data model, enums, sequences, append-only grants | 04 | A1 |
| A3 Auth: Better Auth, role_assignments, CallerContext, session policy | 05 | A1, A2 |
| A4 Firestore repository + Firebase project setup (responses, storage, admin-SDK-only rules) | 04 | A1 |
| A5 Queue infra: BullMQ + Valkey, worker app, repeatable-job registry, job conventions | 03 | A1 |
| A6 Design system: Ember tokens, shadcn theme, lucide, admin shell layout | 15 | A1 |
| A7 DO App Platform: app spec (web/worker/pdf), staging+prod, env validation, Sentry | 03 | A1 |
| A8 Audit service + audit_log writes from services | 04 | A2 |

## Epic B — Products, questionnaires & translations (P1, phase-1)
B1 Product entity + admin CRUD + branding config (04, 11) [A2, A3, A6] · B2 questionnaire-schema package + validator CLI (07) [A1] · B3 Questionnaire version import + activation UI (07) [B1, B2] · B4 Translation strings + resolution with fallback (07) [B1]

## Epic C — Respondent questionnaire engine (P1, phase-1)
C1 Token+PIN access flow with lockout, patterns 1/2 (05) [A2, A6] · C2 Renderer core: sections, navigation, progress save/resume via Firestore (07) [C1, B3, A4] · C3 Core question types: likert, multiple_choice, matrix, numeric, free_text, content (07) [C2] · C4 Ranking + ipsative most/least incl. a11y + component tests (07) [C2] · C5 Branching condition evaluator, exhaustively unit-tested (07) [C2] · C6 Language switcher (07) [C2, B4]

## Epic D — Orders, payments & comms (P1, phase-1)
D1 Order service + 13-state machine + transition table + audit (06) [A2, A8] · D2 Admin order wizard: named + bulk_named (06) [D1, B1, A6] · D3 Payment module: Stripe card + offline adapters + webhook route, idempotent (06) [D1] · D4 Mailer adapter (SendGrid) + notification_log + event webhook (13) [A5] · D5 Invitation dispatch + resend + email_error flow (06, 13) [D1, D4, C1] · D6 Reminder engine: 2-day cycle, 30-day stop, manual controls (13) [D5] · D7 Admin error queue + retry UI for the three error states (06) [D1, A6]

## Epic E — Scoring & reports (P1, phase-1)
E1 Scoring module: interfaces, scoring_jobs, dispatch worker (08) [A5, C2] · E2 Async external adapter + HMAC callback endpoint + watchdog (08) [E1] · E3 Report assembly + release controls (09) [E1] · E4 pdf-service: WeasyPrint FastAPI + PdfRenderer adapter + golden-file tests (09) [A1] · E5 PRO-D report template, web + print modes (09) [E3, E4, B1] · E6 Completion notifications with policy resolution (13) [E3, D4]

## Epic F — White-label & domains (P1, phase-1)
F1 Tenant-resolution middleware + slug subdomains + branding injection (11) [B1] · F2 Custom domain lifecycle + DO API provisioning, incl. questionnaire.pro-d.com (11) [F1, A7]

## Epic G — Commercial breadth (P2, phase-1.5)
G1 Retail: public product page + Stripe Checkout + optional account creation (06) [D3, F1] · G2 Group/team tokens + self-registration + aggregate reports (05, 06, 09) [C2, E3] · G3 Batch codes: pool generation, redemption page, dashboard status (05, 06) [C2, D1] · G4 360 multi-rater orders + rater variants + aggregated report (06, 07, 09) [C2, E5] · G5 Client groups/projects/tags + client_user permissions (04, 05) [D2]

## Epic H — Billing & Xero (P2, phase-1.5)
H1 Entitlements + append-only ledger + atomic enforcement (10) [D1] · H2 Invoices + Xero invoicing adapter + push (10) [H1] · H3 Stripe payout reconciliation to Xero (10) [H2, D3] · H4 Post-pay billing cycle close job (10) [H2]

## Epic I — Partner API & webhooks (P3, phase-2)
I1 API keys + bearer auth + scopes + rate limiting (12) [D1] · I2 Order/results/report-link endpoints + OpenAPI docs (12) [I1] · I3 Outbound webhook subscriptions + signed delivery + retries (12) [I1]

## Epic J — Royalties, owner dashboard & Connect (P3, phase-2)
J1 Royalty ledger + statements + settlement flow (10) [H2] · J2 Assessment-owner dashboard, read-only (05, 10) [J1] · J3 Stripe Connect onboarding + automated transfers (10) [J1]

## Epic K — Migration (P3, phase-2)
K1 Migration script: clients/users/respondents/orders/audit (14) [D1] · K2 Responses + legacy PDF import + legacy report serving (14) [K1, E3] · K3 Legacy ALC redirects + cutover runbook (14) [K2, F2]

## Epic L — Phase-2 breadth (P3, phase-2)
L1 Translation manager UI + additional languages (07) [B4] · L2 Stripe ACH + GoCardless adapter slot (06, 10) [D3, H2] · L3 Self-serve custom domain onboarding (11) [F2]
