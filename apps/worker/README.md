# @assessify/worker

BullMQ worker process (docs/spec/03-architecture.md). All side-effectful async
work — scoring dispatch, callbacks, reminders, notifications, webhook
delivery, Xero pushes — runs here, never in web request handlers.

## How it fits together

| Piece | Where | Role |
|---|---|---|
| Payload schemas | `packages/domain/src/jobs.ts` | One Zod schema per job name, shared by enqueuer and processor |
| `JobQueue` interface | `packages/adapters/src/queue/types.ts` | What services see — `enqueue(jobName, payload, { delayMs, idempotencyKey })` |
| BullMQ provider | `packages/adapters/src/queue/providers/bullmq.ts` | Queue name (`assessify`), retry/backoff + retention defaults |
| Dispatcher | `src/dispatch.ts` | job name → registry lookup → Zod parse → thin processor |
| Processor registry | `src/processors/index.ts` | Mapped type: every domain job name must have a processor (compile error otherwise) |
| Repeatable jobs | `src/repeatable-jobs.ts` | ALL cron-like schedules, registered on boot — never platform cron |

Processors stay thin: parse job → call a service. Business logic lives in
`@assessify/services`.

## Running locally

Valkey is only the BullMQ backing store (never a data store), so a throwaway
container is all you need:

```bash
docker run --rm -p 6379:6379 --name assessify-valkey valkey/valkey:8
```

Then, from the repo root:

```bash
REDIS_URL=redis://localhost:6379 pnpm --filter @assessify/worker dev
```

On boot the worker registers the repeatable jobs and enqueues one
`health.ping` through the JobQueue adapter — you should see
`[worker] health.ping ok (...)` within a second, proving the full
producer → Valkey → processor → service round trip.

Stop it with Ctrl-C (SIGINT) or `kill` (SIGTERM); it drains in-flight jobs
before exiting. (A full docker-compose local stack arrives with A7.)

## Environment

Validated with Zod at boot (`src/env.ts`); the process refuses to start on
missing/invalid config.

| Variable | Required | Notes |
|---|---|---|
| `VALKEY_URL` | one of these two | `redis://` / `rediss://` URL of DO managed Valkey (preferred name in DO) |
| `REDIS_URL` | one of these two | Same, fallback name for local docker / CI |
| `WORKER_CONCURRENCY` | no (default 5) | Max jobs processed concurrently by this process |

## Tests

```bash
pnpm --filter @assessify/worker test
```

Unit tests (dispatcher, processors) mock the service layer and need no Redis.
The integration round trip in `src/queue.int.test.ts` runs only when
`REDIS_URL`/`VALKEY_URL` is set and is skipped cleanly otherwise.

## Adding a job type

1. Add the payload schema to `packages/domain/src/jobs.ts` (`jobPayloadSchemas`).
2. Add a thin processor in `src/processors/` and wire it into
   `createProcessorRegistry` (the compiler forces this).
3. Enqueue from a service via the injected `JobQueue`.
4. If it is cron-like, add an entry to `src/repeatable-jobs.ts` instead of
   enqueueing manually.
