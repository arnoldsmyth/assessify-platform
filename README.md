# Assessify — build workspace

The complete build specification lives in this repo at `docs/spec/` — **start with `docs/spec/00-README.md`.**

The backlog is the beads database in this folder (`.beads/`, prefix `asy`):

```
bd ready        # unblocked work, priority order
bd show <id>    # full issue detail incl. spec references
```

## Repo layout

pnpm + turborepo monorepo (see `docs/spec/03-architecture.md`):

- `apps/web` — Next.js App Router: admin, respondent, and public surfaces + API routes
- `apps/worker` — BullMQ processors (thin: parse job → call service)
- `packages/domain` — entities, enums, Zod schemas, `Result<T, DomainError>`
- `packages/services` — the service layer; all business logic
- `packages/repositories` — Postgres (Drizzle) + Firestore data access
- `packages/adapters` — outbound adapter interfaces (mailer, payment, …); providers injected at composition roots
- `packages/db` — drizzle schema + migrations
- `packages/ui` — shared components + design tokens

Layer boundaries are enforced by dependency-cruiser (`.dependency-cruiser.cjs`, `pnpm lint:boundaries`) per `docs/spec/appendix-architecture-layers.md`.

```
pnpm install
pnpm dev          # all apps via turbo
pnpm lint && pnpm lint:boundaries && pnpm typecheck && pnpm test && pnpm build
```

Notes for build agents:
- First real task is `A1 Monorepo scaffold` (Epic A: Foundations, `asy-aq5.1`). Everything else is dependency-blocked behind it.
- Issue descriptions reference spec docs as `development-files/assessify-spec/NN-*.md` — those files are now `docs/spec/NN-*.md` in this repo.
- The original planning drafts (superseded by the spec package) remain in the legacy repo: `PRO-D-Production-2024/development-files/`.
