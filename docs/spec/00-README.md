# Assessify — Build Specification Package

**Status:** Approved for build · **Date:** 2026-07-09 · **Owner:** Arnold (PRO-D.com)

This folder is the complete, self-contained specification for building **Assessify** — a multi-tenant assessment platform replacing the 2016 PRO-D system. It is written so that a build agent can implement any single document without needing the conversation that produced it.

## How to use this spec (build agents: read this first)

1. Read `01-vision-scope-phasing.md` for what the product is and which phase you are building.
2. Read `03-architecture.md` and `appendix-architecture-layers.md` — the layer model there is **non-negotiable**. Every piece of code you write must respect it.
3. The backlog is managed in **beads** (`bd` CLI). The beads database lives at the repo root (`.beads/`). Run `bd ready` to see unblocked work. Every issue references the spec document(s) that define it. Do not invent scope: if the spec is ambiguous, the issue comments or a human decides — not you.
4. `04-data-model.md` is the source of truth for the schema. Do not add tables or columns casually; schema changes are migrations with review.
5. `15-brand-design-system.md` defines the visual system. Use **lucide** icons throughout. Never introduce another icon set.

## Document index

| Doc | Contents |
|---|---|
| `01-vision-scope-phasing.md` | Product vision, tenancy model, phases MVP → v1.x → v2 |
| `02-legacy-system-analysis.md` | What the old system does, business rules extracted from code, what to keep/kill |
| `03-architecture.md` | Stack, DigitalOcean App Platform topology, services, queue, auth, layer model |
| `04-data-model.md` | Postgres DDL (Neon) + Firestore collections + identifier conventions |
| `05-roles-and-access.md` | 5 roles, permission matrix, 5 respondent access patterns, token/PIN security |
| `06-orders-and-state-machine.md` | 6 order models, 13-state machine, payments, pricing |
| `07-questionnaire-engine.md` | 9 question types, JSON definition schema, branching, localisation, progress save |
| `08-scoring-module.md` | Scoring adapter interface, sync + async modes, callback contract |
| `09-reports-and-pdf.md` | Report templates, WeasyPrint PDF service, release controls, legacy PDFs |
| `10-billing-entitlements-royalties.md` | Plans, entitlement ledger, royalty ledger, Xero adapter, Stripe Connect |
| `11-white-label-domains.md` | Custom domain architecture (questionnaire.pro-d.com etc.), tenant resolution |
| `12-external-api.md` | Partner REST API v1, API keys, webhooks, OpenAPI |
| `13-notifications-and-reminders.md` | Notification policy resolution, mailer adapter, reminder engine |
| `14-migration.md` | Legacy data import mapping, legacy PDF serving, idempotency |
| `15-brand-design-system.md` | Ember palette, typography, tokens, accessibility |
| `16-backlog.md` | Phase → epic → issue breakdown (mirrors the beads database) |
| `appendix-architecture-layers.md` | Layer responsibilities and boundaries (verbatim standard) |

## Source material

The original planning drafts live one level up in `development-files/`:
`assessment-platform-prompt.md` (superseded by this package — where they conflict, **this package wins**; notable supersessions: hosting is DigitalOcean not undecided, PDF is WeasyPrint not Puppeteer, platform brand is Assessify), `assessment-platform-navmap.md`, `schema-companion.md`, and `schema-produsr_app.sql` (legacy MySQL schema).

## Hard rules that apply to every issue

- **Layer boundaries** per `appendix-architecture-layers.md`. Controllers never touch repositories. Services never import framework code.
- **UUIDs in URLs/APIs; human references (`ORD-00042`) for display only.** Never a sequential ID in a URL.
- **No PII in URLs, logs, or outbound scoring payloads** (unless the payload contract explicitly requires it and it is documented).
- **All secrets from environment / DO App Platform secrets.** Never commit a credential. (The legacy repo committed live Stripe keys — that mistake is why this rule is written down.)
- **Every state change on an order writes an audit event** (`audit_log`).
- **TypeScript strict mode; Zod validation at every boundary** (server actions, API routes, queue payloads, scoring callbacks, questionnaire definitions).
- **Tests:** services get unit tests; state machine transitions and entitlement/ledger math get exhaustive tests; question renderers get component tests including validation rules.
