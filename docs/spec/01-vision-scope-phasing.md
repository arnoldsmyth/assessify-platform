# 01 — Vision, Scope & Phasing

## What Assessify is

**Assessify** (assessify.ie) is a multi-tenant SaaS platform for selling and delivering psychometric and organisational assessments. It serves three audiences:

1. **Assessment owners** — businesses that own an assessment product (PRO-D.com is the first and reference tenant; others include KnowingMe, Giftedness Assessment, Team Health Survey, and future third parties). They configure products, monitor usage, and receive revenue share/royalties.
2. **Clients** — coach practices, HR departments, schools, and distributors who buy assessments for the people they work with, in bulk or one at a time.
3. **Respondents (assessment takers)** — the individuals who complete questionnaires and receive reports.

The platform also operates **headless**: third-party assessment owners and partners can place orders and retrieve results machine-to-machine via a documented REST API.

## Brand and surface split — the defining constraint

- The **admin platform** (orders, clients, billing, product config) runs under the single **Assessify** brand at `app.assessify.ie`.
- Every **respondent-facing surface** (questionnaire, report access, redemption pages) is **fully white-labelled per product**: logo, colours, fonts, sender identity. A respondent taking a PRO-D assessment sees only PRO-D.
- White-labelling extends to **DNS**: a client/product can point a domain they own (e.g. `questionnaire.pro-d.com`) at Assessify via CNAME, and all respondent traffic for their product is served under that hostname with valid TLS. Respondents should never see `assessify.ie` unless the product has no custom domain. Architecture in `11-white-label-domains.md`.
- Retail purchases happen on **public product pages** which may live under the product's own domain.

## What replaces what (legacy → Assessify)

| Legacy (2016 system) | Assessify |
|---|---|
| CodeIgniter 3 PHP + AngularJS SPA + Backand BaaS (defunct) | Next.js App Router monorepo, layered architecture |
| MySQL `produsr_app` + Firebase RTDB dual writes | Neon Postgres (relational) + Firestore (response documents) |
| DocRaptor per-document PDF fees | Self-hosted WeasyPrint PDF service |
| TAI external scoring over plain HTTP | Scoring Engine Module: sync internal + async external over HTTPS with signed callbacks |
| Cognito Forms website order intake | Native public product pages + Stripe Checkout |
| Hardcoded discount/rebate magic numbers in PHP | Configurable pricing, entitlement and royalty policies in the database |
| Mailgun/SendGrid/Google-SMTP tangle | Single Mailer adapter (SendGrid default backend) |
| Secrets committed to the repo | DO App Platform secrets + env config, nothing committed |
| Owner/customer two-role model + ad-hoc admin groups | 5 explicit roles with scoped permissions |

## Phasing

The **data model is built in full from day one** (see `04-data-model.md`) — every phase's tables exist from the first migration so later phases never force schema rework. Features are delivered in phases:

### Phase 1 — MVP: the PRO-D core loop (build first)
Goal: a client admin can order a PRO-D assessment for a named person; the person takes it; scoring runs; a PDF report is delivered. Everything else exists as schema only.

- Platform shell: auth (magic link + password), role gating, admin layout
- Products: seed PRO-D product with branding config; questionnaire definition import (JSON upload, validated)
- Orders: **named invitation** and **bulk named** models (Patterns 1–2); full 13-state machine; invoice/offline payment + Stripe card
- Questionnaire engine: all 9 question types, progress save/resume, localisation framework (English first)
- Scoring: async external adapter (the PRO-D/TAI-replacement engine) + sync internal adapter interface
- Reports: one PRO-D report template (React web view + WeasyPrint print CSS), release controls
- Notifications: invitation, reminder (2-day cycle / 30-day stop), report-ready emails
- Audit log, error states + admin retry UI
- White-label per product on the default platform domain (path/subdomain-based); custom-domain plumbing in place for at least `questionnaire.pro-d.com`

### Phase 1.5 — Commercial breadth
- Retail orders (Pattern 4): public product page, Stripe Checkout, optional post-completion account creation
- Group/team tokens (Pattern 3) with individual/aggregate/both report models
- PO batch codes (Pattern 5): pool generation, redemption page, dashboard status
- 360 multi-rater orders with rater relationship types
- Entitlements: prepay credits + post-pay metering, hard-block enforcement, ledgers
- Xero adapter: invoice push, Stripe payout reconciliation
- Client groups/projects/tags; client user permissioning

### Phase 2 — Ecosystem
- External partner API v1 (order placement, status, signed report URLs, webhook subscriptions, OpenAPI docs)
- Assessment Owner dashboard; royalty ledger, statements and settlement
- Stripe Connect transfers (fields exist from day one; automated transfers here)
- Additional languages per product; translation manager UI
- Legacy data migration + legacy PDF serving (can be pulled earlier if cutover date demands)
- Stripe ACH (`us_bank_account`) for invoice/batch flows; GoCardless adapter slot
- Self-serve custom domain onboarding (admin-assisted in earlier phases)

### Explicitly out of scope (all phases as specced)
- UI questionnaire builder (definitions are AI-authored JSON, admin-imported)
- UI report template editor (templates are code, one per product)
- Order top-ups after creation
- SSO (SAML/OIDC) — desirable later, not specced here

## Success criteria for MVP

1. A real PRO-D order completes end-to-end in production: order → invite → questionnaire → scoring callback → PDF downloaded — with zero manual intervention.
2. A 23-page report PDF renders in under 10 seconds (target 1–3s).
3. A respondent on `questionnaire.pro-d.com` never sees the Assessify brand.
4. Every order state transition is visible in the admin UI with actor + timestamp, and error states (`payment_error`, `email_error`, `scoring_error`) alert an admin and offer retry.
