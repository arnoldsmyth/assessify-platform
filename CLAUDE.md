# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

pnpm + turborepo monorepo. Node ≥22, pnpm 10.

```bash
pnpm install
pnpm dev               # all apps (turbo)
pnpm lint              # eslint (flat config, root)
pnpm lint:boundaries   # dependency-cruiser layer rules — must pass
pnpm typecheck         # tsc --noEmit per package (turbo)
pnpm test              # vitest (turbo)
pnpm build             # next build etc. (turbo)
```

## Architecture Overview

Spec is in `docs/spec/` — start at `docs/spec/00-README.md`. The layer model in
`docs/spec/03-architecture.md` + `docs/spec/appendix-architecture-layers.md` is
**non-negotiable**.

- `apps/web` — Next.js App Router; surfaces: `(admin)`, `(respondent)`, `(public)`, plus `api/v1`, `api/webhooks`, `report-print/[id]`
- `apps/worker` — BullMQ processors, thin: parse job → call service
- `packages/domain` → innermost: entities, Zod schemas, `Result<T, DomainError>`
- `packages/services` → all business logic; never imports frameworks, apps, or adapter providers
- `packages/repositories` → Drizzle/Firestore data access; never imports services
- `packages/adapters` → interfaces in `src/<name>/types.ts`, concrete providers in `src/<name>/providers/` (injected at composition roots)
- `packages/db` → drizzle schema + migrations
- `packages/ui` → shared components + design tokens

## Conventions & Patterns

- Layer boundaries enforced by `.dependency-cruiser.cjs` (`pnpm lint:boundaries`); CI fails on violations. Controllers never import repositories or db.
- Services return `Result<T, DomainError>` (from `@assessify/domain`) — no throwing across layer boundaries for expected failures.
- TypeScript strict everywhere; Zod validation at every boundary.
- UUIDv7 PKs; human refs (`ORD-00042`) display-only, never in URLs. Money in integer minor units. Time as `timestamptz` UTC.
- Secrets only via env (DO App Platform); never commit credentials.
