/**
 * Repeatable-job registry (docs/spec/03-architecture.md, "Topology"):
 * cron-like work = BullMQ repeatable jobs registered by the worker on boot —
 * never platform cron — so every schedule lives in code, in this one file.
 *
 * `upsertJobScheduler` is idempotent per `schedulerId`: re-registering on
 * every boot updates a changed schedule in place, and multiple worker
 * replicas registering the same list is safe. Removing an entry here does
 * NOT delete an already-persisted scheduler — deleting one is a deliberate
 * op (`queue.removeJobScheduler(id)`), so note it in the PR that drops it.
 */
import type { Queue } from 'bullmq';
import { jobPayloadSchemas, type JobName, type JobPayload } from '@assessify/domain';

export interface RepeatableJob<N extends JobName = JobName> {
  /** Stable scheduler key in Valkey — renaming it orphans the old schedule. */
  schedulerId: string;
  jobName: N;
  /** Cron `pattern` (5-field, UTC) or fixed `every` interval in ms. */
  repeat: { pattern: string } | { every: number };
  payload: JobPayload<N>;
}

/** Identity helper so each entry's payload is type-checked against its jobName. */
function define<N extends JobName>(job: RepeatableJob<N>): RepeatableJob<N> {
  return job;
}

export const repeatableJobs: readonly RepeatableJob[] = [
  // No-op heartbeat proving the scheduler pattern; also makes a dead worker
  // visible (no "[worker] heartbeat" log line for >5 min = investigate).
  define({
    schedulerId: 'heartbeat',
    jobName: 'maintenance.heartbeat',
    repeat: { every: 5 * 60_000 },
    payload: {},
  }),
  // Reminder engine (D6 — spec 13): hourly sweep; the service applies the
  // 2-day spacing / 30-day stop and defers sends outside the 08:00–18:00
  // product-local window to a later tick, so hourly is the right resolution.
  define({
    schedulerId: 'reminder-sweep',
    jobName: 'reminders.sweep',
    repeat: { pattern: '0 * * * *' },
    payload: {},
  }),
];

export async function registerRepeatableJobs(
  queue: Pick<Queue, 'upsertJobScheduler'>
): Promise<void> {
  for (const job of repeatableJobs) {
    // Schedules are code: a payload that fails its own schema is a
    // programmer error, so fail the boot rather than enqueue garbage forever.
    jobPayloadSchemas[job.jobName].parse(job.payload);
    await queue.upsertJobScheduler(job.schedulerId, job.repeat, {
      name: job.jobName,
      data: job.payload,
    });
    console.log(
      `[worker] registered repeatable job "${job.schedulerId}" → ${job.jobName} (${JSON.stringify(job.repeat)})`
    );
  }
}
