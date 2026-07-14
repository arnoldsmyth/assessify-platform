/**
 * Job dispatcher: the single BullMQ processor callback. Looks the job name up
 * in the registry, parses the payload against the domain schema (the same one
 * the enqueuer validated with), then hands the typed payload to the thin
 * processor.
 *
 * Error semantics:
 * - unknown job name / invalid payload → `UnrecoverableError`: retrying a
 *   malformed job can never succeed, so it goes straight to the failed set
 *   instead of burning its 5 attempts;
 * - anything a processor throws → normal failure, retried per the queue's
 *   default backoff (packages/adapters/src/queue/providers/bullmq.ts).
 */
import { UnrecoverableError } from 'bullmq';
import { isJobName, jobPayloadSchemas } from '@assessify/domain';
import type { ProcessorRegistry } from './processors';

/** The slice of a BullMQ Job the dispatcher reads — keeps tests BullMQ-free. */
export interface IncomingJob {
  name: string;
  data: unknown;
}

export async function dispatchJob(
  registry: ProcessorRegistry,
  job: IncomingJob
): Promise<void> {
  if (!isJobName(job.name)) {
    throw new UnrecoverableError(`no processor registered for job "${job.name}"`);
  }
  const parsed = jobPayloadSchemas[job.name].safeParse(job.data);
  if (!parsed.success) {
    throw new UnrecoverableError(
      `invalid payload for job "${job.name}": ${parsed.error.message}`
    );
  }
  // Safe: `parsed.data` came from the schema keyed by exactly `job.name`;
  // the registry's mapped type guarantees the handler matches that name.
  const handler = registry[job.name] as (payload: unknown) => Promise<void>;
  await handler(parsed.data);
}
