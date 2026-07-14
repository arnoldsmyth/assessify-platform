/**
 * BullMQ JobQueue provider (docs/spec/03-architecture.md).
 *
 * Topology: a single queue (`assessify`) with named jobs, consumed by one
 * BullMQ Worker in apps/worker that dispatches on `job.name`. Splitting hot
 * job types onto their own queues later is a composition-root change only —
 * services see the JobQueue interface and never this file (enforced by
 * .dependency-cruiser.cjs).
 *
 * Concrete provider — wired at each app's composition root.
 */
import { Queue, type JobsOptions } from 'bullmq';
// NB: bullmq pins ioredis to an exact version; our package.json pins the
// same one so the Redis instance type below stays assignable to BullMQ's
// ConnectionOptions. Bump both together.
import IORedis from 'ioredis';
import { jobPayloadSchemas, type JobName, type JobPayload } from '@assessify/domain';
import {
  JobQueueError,
  type EnqueuedJob,
  type EnqueueOptions,
  type JobQueue,
} from '../types';

/** Single shared queue name; the worker listens on the same constant. */
export const ASSESSIFY_QUEUE_NAME = 'assessify';

/**
 * Default job options, applied to every enqueue:
 *
 * - `attempts: 5` with exponential backoff starting at 5 s (5 s, 10 s, 20 s,
 *   40 s) — transient downstream failures (scoring engines, SendGrid, Xero)
 *   get retried without hammering; a job that fails 5 times parks in the
 *   failed set for inspection.
 * - `removeOnComplete` — keep at most 1 000 completed jobs for up to 24 h so
 *   `docker exec valkey redis-cli`/dashboards can show recent history, while
 *   honouring "Valkey is never a data store".
 * - `removeOnFail` — keep failures for 7 days so the admin error queue can
 *   surface them before they age out.
 */
export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

/**
 * The slice of a BullMQ Queue the provider needs. Injectable so unit tests
 * (and the worker, which already owns a Queue instance) never open a Redis
 * connection here.
 */
export interface BullQueueLike {
  add(
    name: string,
    data: unknown,
    opts?: JobsOptions
  ): Promise<{ id?: string | undefined }>;
}

export type BullMqJobQueueOptions =
  | {
      /** Reuse an existing BullMQ Queue (or a test double). Caller owns its lifecycle. */
      queue: BullQueueLike;
      connectionUrl?: undefined;
      queueName?: undefined;
    }
  | {
      /** `redis://` / `rediss://` connection string for DO Valkey or local docker. */
      connectionUrl: string;
      /** Defaults to {@link ASSESSIFY_QUEUE_NAME}. */
      queueName?: string;
      queue?: undefined;
    };

export class BullMqJobQueue implements JobQueue {
  private readonly queue: BullQueueLike;
  /** Set only when this instance created the connection (and thus owns it). */
  private readonly owned?: { queue: Queue; connection: IORedis };

  constructor(options: BullMqJobQueueOptions) {
    if (options.queue) {
      this.queue = options.queue;
      return;
    }
    // BullMQ requires maxRetriesPerRequest: null on its connections.
    const connection = new IORedis(options.connectionUrl, {
      maxRetriesPerRequest: null,
    });
    const queue = new Queue(options.queueName ?? ASSESSIFY_QUEUE_NAME, {
      connection,
      defaultJobOptions,
    });
    this.queue = queue;
    this.owned = { queue, connection };
  }

  async enqueue<N extends JobName>(
    jobName: N,
    payload: JobPayload<N>,
    options?: EnqueueOptions
  ): Promise<EnqueuedJob> {
    // Runtime guard for dynamic call sites; same schema the worker's
    // dispatcher parses with (packages/domain/src/jobs.ts), so producer and
    // consumer can never disagree about a payload shape.
    const parsed = jobPayloadSchemas[jobName].safeParse(payload);
    if (!parsed.success) {
      throw new JobQueueError(
        `invalid payload for job "${jobName}": ${parsed.error.message}`
      );
    }

    let job: { id?: string | undefined };
    try {
      job = await this.queue.add(jobName, parsed.data, {
        ...(options?.delayMs !== undefined && { delay: options.delayMs }),
        // BullMQ dedupes on jobId: adding an id that already exists on the
        // queue is a no-op, which is exactly the idempotency-key contract.
        ...(options?.idempotencyKey !== undefined && {
          jobId: options.idempotencyKey,
        }),
      });
    } catch (cause) {
      throw new JobQueueError(
        `failed to enqueue "${jobName}": ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    return { jobId: job.id ?? jobName };
  }

  /** Close the queue/connection this instance created (no-op when injected). */
  async close(): Promise<void> {
    if (this.owned) {
      await this.owned.queue.close();
      await this.owned.connection.quit();
    }
  }
}
