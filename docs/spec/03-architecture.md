# 03 — Architecture

## Stack (decided)

| Concern | Choice | Notes |
|---|---|---|
| Web app | **Next.js (App Router), TypeScript strict** | Single app serving admin, respondent, and public surfaces + API routes |
| Relational DB | **Neon Postgres** | Source of truth for all structured data. Drizzle ORM for typed schema + migrations |
| Response store | **Firestore** | Questionnaire responses + in-progress state (structurally varied documents) |
| File storage | **Firebase Storage** | Branding assets, legacy PDFs. New PDFs are never stored |
| Queue / jobs | **BullMQ on DO Managed Valkey (Redis-compatible)** | Scoring dispatch, callbacks processing, reminders, notifications, webhook delivery, Xero pushes |
| PDF | **WeasyPrint (Python 3 + FastAPI) internal service** | Replaces DocRaptor/Prince. Same paged-CSS model; zero per-doc cost. See `09` |
| Auth | **Better Auth** (Postgres-backed) | Email/password + magic links; roles/scopes are our own tables (`05`) |
| Payments | **Stripe** (card now, ACH later) + offline/invoice adapter | GoCardless is a v2 adapter slot |
| Email | **SendGrid** behind the Mailer adapter | Event webhook for delivery/open tracking |
| Accounting | **Xero** behind the Invoicing adapter | |
| Hosting | **DigitalOcean App Platform** | All services in one DO App; managed Valkey attached |
| Monitoring | DO logs + Sentry | Error states also surface in the admin error queue |

### Why these (one paragraph each, for the record)

**DigitalOcean App Platform** (owner decision): container-based, so long-running workers and the Python PDF service are first-class (no serverless Chromium/timeout contortions); supports per-component scaling, managed TLS, and custom domains added via the DO API — needed for white-label domains (`11`). **WeasyPrint over Puppeteer** (owner decision): the legacy report templates were written for DocRaptor/Prince, i.e. static HTML + paged CSS (`@page`, `page-break-*`) with no JS — WeasyPrint implements exactly this model, so report authoring carries over conceptually; charts must be server-rendered SVG (they must never depend on browser JS anyway). If a future template genuinely needs browser rendering, a Puppeteer adapter can implement the same `PdfRenderer` interface — the service layer never knows. **Better Auth over Clerk/Auth.js**: self-hosted (no per-MAU fee across five roles and thousands of respondents), Postgres-native, magic links built in; respondent access is deliberately *not* auth-based (token + PIN, see `05`), so the auth system only serves staff/client users — keep it simple and owned. **Drizzle over Prisma**: SQL-first migrations reviewable in PRs, lighter runtime for App Platform containers, and the DDL in `04` maps 1:1.

## Topology (one DO App, four components)

```
                          ┌──────────────────────────────────────────────┐
                          │ DigitalOcean App Platform                    │
   app.assessify.ie ────▶ │ ┌──────────┐   ┌─────────┐   ┌─────────────┐ │
   *.assessify.ie  ────▶  │ │  web     │──▶│ valkey  │◀──│  worker     │ │
   questionnaire.pro-d.com│ │ Next.js  │   │ (queue) │   │ Node+BullMQ │ │
   (client CNAMEs)        │ └─────┬────┘   └─────────┘   └──────┬──────┘ │
                          │       │      ┌────────────┐         │        │
                          │       └────▶ │ pdf-service│ ◀───────┘        │
                          │              │ WeasyPrint │                  │
                          │              └────────────┘                  │
                          └──────────────────────────────────────────────┘
                                  │                │
                           Neon Postgres      Firestore / Firebase Storage
                                  │
                     Stripe · SendGrid · Xero · external scoring engines
```

- **web** — Next.js. Serves the three surfaces (below) and all API routes. Stateless; scale horizontally.
- **worker** — Node process running BullMQ processors. Imports the same service layer as web (monorepo package). All side-effectful async work happens here, not in request handlers.
- **pdf-service** — Python FastAPI + WeasyPrint. Internal-only (not routable publicly). Contract in `09`.
- **valkey** — DO managed Valkey; BullMQ backing store only, never a data store.

Cron-like work (reminder sweep, post-pay billing cycle close, webhook retry) = BullMQ **repeatable jobs** registered by the worker on boot — not platform cron, so schedules live in code and are visible in one place.

## Repo layout (monorepo, pnpm + turborepo)

```
assessify/
  apps/
    web/                      # Next.js app
      app/(admin)/...         # Assessify-branded admin surface
      app/(respondent)/...    # white-labelled: token entry, questionnaire, report viewer
      app/(public)/...        # product pages, retail checkout, code redemption
      app/api/v1/...          # external REST API (12)
      app/api/webhooks/...    # stripe, sendgrid, scoring callbacks
      app/report-print/[id]/  # internal print route consumed by pdf-service (09)
    worker/                   # BullMQ processors (thin: parse job → call service)
    pdf-service/              # Python FastAPI + WeasyPrint (09)
  packages/
    services/                 # SERVICE LAYER — all business logic
    repositories/             # postgres/ (Drizzle) and firestore/ repos
    adapters/                 # payment/, scoring/, mailer/, storage/, invoicing/, pdf/
    domain/                   # entities, enums, state machine defs, Zod schemas
    db/                       # drizzle schema + migrations
    questionnaire-schema/     # JSON definition Zod schema + validator CLI (07)
    ui/                       # shared components, design tokens (15), lucide icons
```

**Dependency rule enforcement:** ESLint `import/no-restricted-paths` (or dependency-cruiser) in CI fails the build if: an `app/` file imports from `repositories`; `services` imports from `apps/`, `adapters` implementations (interfaces only — injected), or any framework package; `repositories` imports `services`. See `appendix-architecture-layers.md` for the full contract. MCP tools, if added later, are a third controller surface with the same rules.

## The three web surfaces and tenant resolution

Every request passes middleware that resolves a **surface context**:

1. `app.assessify.ie` → admin surface, Assessify brand, session auth.
2. Custom domain (e.g. `questionnaire.pro-d.com`) → look up `custom_domains` by hostname → product context → respondent/public surface with that product's branding. Details in `11`.
3. `{product-slug}.assessify.ie` → same as (2) via slug (fallback when no custom domain).

Respondent surface routes never render admin components and vice versa; the branding config (colours, logo URL, fonts) is loaded server-side per request and injected as CSS variables.

## Cross-cutting conventions

- **IDs:** UUIDv7 primary keys everywhere (time-ordered, index-friendly). Human references (`ORD-00042`, `INV-2607-00123`) generated from Postgres sequences, display/search only. Full rules in `04`.
- **Money:** integer minor units (cents) + ISO currency column. Never floats.
- **Time:** `timestamptz` UTC in DB; product/client display timezone is a config field.
- **Errors:** services return typed results (`Result<T, DomainError>` pattern); controllers map `DomainError` → HTTP status / UI message. No throwing across layer boundaries for expected failures.
- **Validation:** Zod schemas in `packages/domain`, shared by server actions, API routes, and workers. One schema per payload, defined once.
- **Audit:** `auditService.record(actor, action, entityRef, detail)` called from services (not controllers) on every state-changing operation.
- **Feature flags:** simple `platform_settings` table; no third-party flag service.
- **Env/secrets:** validated at boot with a Zod env schema; missing config fails fast. All secrets via DO App Platform encrypted env vars.

## Environments

- `production` — DO App (web ×2, worker ×1, pdf ×1 to start), Neon prod branch, Firestore prod project.
- `staging` — separate DO App, **Neon branch** of prod (cheap copy-on-write), separate Firebase project, Stripe test mode.
- `local` — docker-compose: Postgres, Valkey, Firebase emulators, pdf-service; `pnpm dev`.
- CI (GitHub Actions): typecheck, lint (incl. layer-boundary rules), unit tests, drizzle migration check, build. Deploy to DO via app spec on merge to `main` (staging) and tag (production).
