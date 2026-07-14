/**
 * JobQueue adapter contract (docs/spec/03-architecture.md: BullMQ on DO
 * managed Valkey — the queue backing store only, never a data store).
 *
 * Services enqueue background work through this interface without knowing
 * the queue technology; the BullMQ provider in ./providers/bullmq.ts is
 * wired at each app's composition root (services never import it — enforced
 * by .dependency-cruiser.cjs).
 *
 * Job names and payload schemas live in `@assessify/domain` (`jobs.ts`) —
 * one schema per payload, shared by enqueuer and processor, so the compile-
 * time types here and the worker's runtime validation can never drift apart.
 */
import type { JobName, JobPayload } from '@assessify/domain';

export interface EnqueueOptions {
  /** Delay processing by this many milliseconds (e.g. scheduled reminders). */
  delayMs?: number;
  /**
   * Deduplication key. While a job with this key already exists on the queue
   * (waiting, delayed, or active), enqueueing again with the same key is a
   * no-op — use it to make retried request handlers idempotent.
   */
  idempotencyKey?: string;
}

export interface EnqueuedJob {
  /** Provider-assigned job id (the idempotency key when one was given). */
  jobId: string;
}

export interface JobQueue {
  /**
   * Enqueue a background job by name. The payload is typed by the job-name →
   * schema registry in `@assessify/domain` and re-validated at runtime by
   * the provider; rejects with `JobQueueError` on invalid payloads or
   * transport failures.
   */
  enqueue<N extends JobName>(
    jobName: N,
    payload: JobPayload<N>,
    options?: EnqueueOptions
  ): Promise<EnqueuedJob>;
}

/** Thrown by JobQueue providers on invalid payloads or transport failures. */
export class JobQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobQueueError';
  }
}
