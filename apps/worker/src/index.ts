/**
 * Worker entrypoint — the composition root (docs/spec/03-architecture.md).
 *
 * Boot sequence:
 *   1. validate env (fail fast on missing VALKEY_URL/REDIS_URL);
 *   2. open one shared ioredis connection to DO Valkey (queue backing store
 *      only — never a data store);
 *   3. build the processor registry with real services injected;
 *   4. start the BullMQ Worker on the shared `assessify` queue, dispatching
 *      on job name;
 *   5. register the repeatable-job schedules (idempotent upsert);
 *   6. enqueue one `health.ping` through the same JobQueue adapter services
 *      use — a live round trip proving producer → Valkey → processor →
 *      service on every boot.
 *
 * Retry/backoff and retention defaults live with the provider
 * (packages/adapters/src/queue/providers/bullmq.ts, `defaultJobOptions`).
 */
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { getHealth, getNotificationService, getScoringService } from '@assessify/services';
import type { Mailer } from '@assessify/adapters';
import {
  ASSESSIFY_QUEUE_NAME,
  BullMqJobQueue,
  defaultJobOptions,
} from '@assessify/adapters/queue/bullmq';
import { createConsoleMailer } from '@assessify/adapters/mailer/console';
import { createSendGridMailer } from '@assessify/adapters/mailer/sendgrid';
import { createInternalSyncScoringAdapter } from '@assessify/adapters/scoring/internal-sync';
import { loadWorkerEnv } from './env';
import { dispatchJob } from './dispatch';
import { createProcessorRegistry } from './processors';
import { registerRepeatableJobs } from './repeatable-jobs';

async function main(): Promise<void> {
  const env = loadWorkerEnv();

  // BullMQ requires maxRetriesPerRequest: null; one connection is shared by
  // the producer Queue and consumer Worker in this process.
  const connection = new IORedis(env.connectionUrl, { maxRetriesPerRequest: null });
  connection.on('error', (error) => {
    console.error(`[worker] valkey connection error: ${error.message}`);
  });

  const queue = new Queue(ASSESSIFY_QUEUE_NAME, { connection, defaultJobOptions });
  const jobQueue = new BullMqJobQueue({ queue });

  // Composition root: concrete Mailer provider chosen here, injected into the
  // service — nothing below the composition root knows which one it got.
  const mailer: Mailer = env.sendgridApiKey
    ? createSendGridMailer({ apiKey: env.sendgridApiKey })
    : createConsoleMailer();
  if (!env.sendgridApiKey) {
    console.log('[worker] SENDGRID_API_KEY not set — using console mailer (dev only)');
  }
  const notifications = env.databaseUrl
    ? getNotificationService({ mailer, queue: jobQueue })
    : undefined;
  if (!env.databaseUrl) {
    console.log('[worker] DATABASE_URL not set — notifications.send jobs will fail');
  }

  // Scoring (E1): the internal sync engine ships with the worker; the E2
  // async-external wrapper joins this map when it lands. `queue` lets the
  // service re-enqueue retries through the same adapter services use.
  const scoring = env.databaseUrl
    ? getScoringService({
        queue: jobQueue,
        adapters: { sync_internal: createInternalSyncScoringAdapter() },
      })
    : undefined;
  if (!env.databaseUrl) {
    console.log('[worker] DATABASE_URL not set — scoring.dispatch jobs will fail');
  }

  const registry = createProcessorRegistry({
    health: { getHealth },
    notifications: { service: notifications },
    scoring: { service: scoring },
  });
  const worker = new Worker(ASSESSIFY_QUEUE_NAME, (job) => dispatchJob(registry, job), {
    connection,
    concurrency: env.concurrency,
  });

  worker.on('completed', (job) => {
    console.log(`[worker] completed ${job.name} (${job.id})`);
  });
  worker.on('failed', (job, error) => {
    console.error(`[worker] failed ${job?.name ?? '<unknown>'} (${job?.id}): ${error.message}`);
  });
  worker.on('error', (error) => {
    console.error(`[worker] error: ${error.message}`);
  });

  await registerRepeatableJobs(queue);

  // Boot-time demo round trip via the adapter interface (see module docs).
  await jobQueue.enqueue('health.ping', {
    requestedAt: new Date().toISOString(),
    source: 'worker-boot',
  });

  // Graceful shutdown: DO App Platform sends SIGTERM on deploy/scale-down.
  // worker.close() waits for in-flight jobs before resolving; anything still
  // queued is picked up by the next worker instance.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, draining in-flight jobs...`);
    await worker.close();
    await queue.close();
    await connection.quit();
    console.log('[worker] shut down cleanly');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    `[worker] listening on queue "${ASSESSIFY_QUEUE_NAME}" (concurrency ${env.concurrency})`
  );
}

main().catch((error: unknown) => {
  console.error('[worker] fatal:', error instanceof Error ? error.message : error);
  process.exit(1);
});
