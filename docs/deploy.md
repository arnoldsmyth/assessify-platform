# Deploying Assessify

## Local Docker preview

`docker-compose.yml` runs the whole stack — Postgres, Redis, `pdf-service`,
`web`, `worker` — with local-only throwaway credentials, migrations applied
automatically before `web`/`worker` start:

```bash
docker compose up --build
# once healthy, create the first admin (no self-serve signup by design):
docker compose exec web pnpm --filter @assessify/web exec tsx scripts/bootstrap-admin.ts \
  you@example.com "a strong password" "Your Name"
```

Open `http://localhost:3000/login`. This is the fastest way to see the admin
UI working end to end; it is not a production deployment target.

## Hosting (Coolify + Hetzner)

Owner decision 2026-07-20: hosting is **Coolify** (deploys from this GitHub
repo) with **Hetzner Object Storage** (S3-compatible) for assets, not
DigitalOcean. `apps/web/Dockerfile`, `apps/worker/Dockerfile`, and
`apps/pdf-service/Dockerfile` are what Coolify builds from — the same images
`docker-compose.yml` uses above. Full Coolify service setup (env vars per
service, Postgres, Redis, custom domains) is tracked as `asy-2m9` — not yet
written up.

## Superseded: DigitalOcean App Platform (historical)

The rest of this document describes the original DO App Platform plan
(`.do/app.yaml`, `.do/app.staging.yaml`). Both spec files are marked
superseded and kept for reference only — hosting moved to Coolify. Skip to
**Local Docker preview** above unless you're specifically resurrecting the
DO path.

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
