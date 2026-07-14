/**
 * Background-job contracts (docs/spec/03-architecture.md, "Validation": one
 * schema per payload, defined once, shared by every consumer).
 *
 * Every queue job type gets exactly one Zod payload schema here, keyed by its
 * job name. Producers (services enqueueing through the JobQueue adapter) and
 * consumers (apps/worker processors) both parse against these schemas — a
 * payload shape is never redefined anywhere else.
 *
 * Job-name convention: `<area>.<verb>` (e.g. `health.ping`,
 * `reminders.sweep`, `webhooks.deliver`). Names are wire-visible in Valkey
 * and in dashboards, so treat renames as breaking changes.
 */
import { z } from 'zod';

/**
 * Trivial round-trip job proving the queue wiring end to end: enqueued via
 * the JobQueue adapter, processed by the worker's health-ping processor,
 * which calls the health service.
 */
export const healthPingPayloadSchema = z.object({
  /** ISO-8601 timestamp set by the enqueuer. */
  requestedAt: z.string().datetime(),
  /** Which component enqueued the ping (e.g. `worker-boot`, `web`). */
  source: z.string().min(1),
});

/**
 * No-op repeatable job demonstrating the scheduler-registry pattern
 * (apps/worker/src/repeatable-jobs.ts). Real cron-like jobs (reminder sweep,
 * billing cycle close, webhook retry) arrive with their epics.
 */
export const heartbeatPayloadSchema = z.object({});

/** Single source of truth mapping job name → payload schema. */
export const jobPayloadSchemas = {
  'health.ping': healthPingPayloadSchema,
  'maintenance.heartbeat': heartbeatPayloadSchema,
} as const;

export type JobName = keyof typeof jobPayloadSchemas;

export type JobPayload<N extends JobName> = z.infer<(typeof jobPayloadSchemas)[N]>;

export function isJobName(name: string): name is JobName {
  return name in jobPayloadSchemas;
}
