/**
 * Optional integration round trip against a real Redis/Valkey. Skipped
 * cleanly unless REDIS_URL (or VALKEY_URL) is set — CI and plain `pnpm test`
 * never need a live queue.
 *
 *   docker run --rm -p 6379:6379 valkey/valkey:8
 *   REDIS_URL=redis://localhost:6379 pnpm --filter @assessify/worker test
 */
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ok } from '@assessify/domain';
import { BullMqJobQueue } from '@assessify/adapters/queue/bullmq';
import { dispatchJob } from './dispatch';
import { createProcessorRegistry, type ProcessorRegistry } from './processors';

const connectionUrl = process.env.REDIS_URL ?? process.env.VALKEY_URL;

describe.runIf(connectionUrl !== undefined)('queue round trip (integration)', () => {
  const queueName = `assessify-int-test-${Date.now()}`;
  let connection: IORedis;
  let queue: Queue;
  let worker: Worker;
  let registry: ProcessorRegistry;
  const getHealth = vi.fn(() =>
    ok({ status: 'ok' as const, timestamp: new Date().toISOString() })
  );

  beforeAll(() => {
    connection = new IORedis(connectionUrl as string, { maxRetriesPerRequest: null });
    queue = new Queue(queueName, { connection });
    registry = createProcessorRegistry({
      health: { getHealth },
      notifications: { service: undefined },
    });
    worker = new Worker(queueName, (job) => dispatchJob(registry, job), { connection });
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });

  it('enqueues via the JobQueue adapter and processes through the registry', async () => {
    const completed = new Promise<string>((resolve, reject) => {
      worker.on('completed', (job) => resolve(job.name));
      worker.on('failed', (_job, error) => reject(error));
    });

    const jobQueue = new BullMqJobQueue({ queue });
    const { jobId } = await jobQueue.enqueue('health.ping', {
      requestedAt: new Date().toISOString(),
      source: 'int-test',
    });

    expect(jobId).toBeTruthy();
    await expect(completed).resolves.toBe('health.ping');
    expect(getHealth).toHaveBeenCalledOnce();
  }, 15_000);
});
