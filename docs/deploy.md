# Deploying Assessify (A7 — DO App Platform)

Topology per `docs/spec/03-architecture.md`: one DO App per environment with
four components — `web` (Next.js), `worker` (BullMQ), `pdf-service`
(WeasyPrint, internal-only), and a managed Valkey cluster. Specs live in
`.do/app.yaml` (production) and `.do/app.staging.yaml` (staging).

## One-time provisioning (owner action — needs real credentials)

These steps require the DO account, Neon account, and provider keys. Nothing
in the repo can (or should) do them automatically:

1. **Neon**: create the production project/database; create a `staging`
   branch of it. Note both connection strings (`sslmode=require`).
2. **DO Managed Valkey**: `doctl databases create assessify-valkey
   --engine valkey --region ams` (and `assessify-valkey-staging`). The app
   specs attach them by `cluster_name`.
3. **DO Spaces**: create buckets `assessify-prod` / `assessify-staging`
   (region `ams3`) + a Spaces access key pair per environment.
4. **Apps**: `doctl apps create --spec .do/app.staging.yaml` then
   `doctl apps create --spec .do/app.yaml`. On first create, set every
   `type: SECRET` env value in the DO console (or via a spec copy with values
   — never commit it): `DATABASE_URL`, `BETTER_AUTH_SECRET`,
   `RESPONDENT_SESSION_SECRET`, `SENDGRID_API_KEY`,
   `SENDGRID_WEBHOOK_PUBLIC_KEY`, `DO_SPACES_KEY`, `DO_SPACES_SECRET`,
   `PDF_SERVICE_SHARED_SECRET`, `SENTRY_DSN`.
   Generate secrets with `openssl rand -base64 32`.
5. **DNS**: point `app.assessify.ie` + `staging.assessify.ie` at the apps
   (DO provides the CNAME target after create). Wildcard
   `*.assessify.ie` for product slugs and client custom domains
   (e.g. `questionnaire.pro-d.com`) are managed by F2 via the DO API.
6. **Migrations**: `packages/db` currently has `drizzle-kit generate` only —
   there is no `migrate` runner script yet (applying migrations needs a live
   `DATABASE_URL`, which no environment has had so far). Add
   `drizzle-kit migrate` as a `migrate` script when the first Neon database
   exists, and run it against each environment before first deploy.
7. **Sentry**: create one project per app (web/worker), note DSNs.
8. **GitHub Actions secrets** (for the deploy workflow when enabled):
   `DIGITALOCEAN_ACCESS_TOKEN`, `DO_APP_ID_STAGING`, `DO_APP_ID_PROD`.

## Deploy flow (once provisioned)

- **Staging** — `deploy_on_push: true` on `main`: every merged PR/push to
  `main` rebuilds and deploys staging automatically.
- **Production** — tag-driven from CI (App Platform has no native
  tag trigger): push a `v*` tag → CI runs the full gate suite, then
  `doctl apps update $DO_APP_ID_PROD --spec .do/app.yaml` (spec change) or
  `doctl apps create-deployment $DO_APP_ID_PROD` (code-only). The workflow is
  added when `DIGITALOCEAN_ACCESS_TOKEN` exists; until then production
  deploys are a manual `doctl` command from a trusted machine.

## Environment validation

Both Node apps validate env at boot with Zod and fail fast
(`apps/web/lib/env.ts`, `apps/worker/src/env.ts`); the pdf-service requires
`PDF_SERVICE_SHARED_SECRET` when set (disabled only for local dev). All
variables are documented in `.env.example`.

## Local development

`.env` from `.env.example`; `pnpm dev` (web + worker via turbo), pdf-service
per its README (`uv run python -m uvicorn app.main:app --reload --port 8080`).
