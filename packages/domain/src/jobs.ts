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

import { notificationRequestSchema } from './notifications';

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

/**
 * Async notification send (spec 13: every send goes through the worker —
 * no emails from request handlers). The notification service writes the
 * `notification_log` row (`queued`) and enqueues this job; the worker
 * processor hands the payload back to the service for delivery.
 *
 * The payload carries the full message (recipient included) because
 * `notification_log` intentionally stores no template data; Valkey holds it
 * only transiently while the job is in flight. Never log the payload.
 */
export const notificationSendPayloadSchema = z.object({
  /** `notification_log.id` created by the enqueuing service (also the dedupe key). */
  notificationId: z.string().uuid(),
  message: notificationRequestSchema,
});

/**
 * Async scoring dispatch (spec 08 flow): `scoringService.dispatch(sessionId)`
 * creates the `scoring_jobs` row (status `queued`) and enqueues this job; the
 * worker processor hands the job id back to `scoringService.processJob`,
 * which loads the submitted answers, calls the product's scoring adapter and
 * applies the outcome. The payload is the job id only — answers are always
 * re-read from the response store, never carried through Valkey.
 */
export const scoringDispatchPayloadSchema = z.object({
  /** `scoring_jobs.id` created by the scoring service (also the dedupe key). */
  jobId: z.string().uuid(),
});

/**
 * Invitation dispatch/resend for one order (D5 — spec 06/05/13). Enqueued by
 * the admin "send invitations" action (order `approved`) or a resend action;
 * the worker processor hands the payload to the invitation service, which
 * generates+hashes PINs, sends invitation emails through the notification
 * service, and drives the order state machine (`invitations_sent` /
 * `invitation_failed`). The payload carries ids only — never respondent PII
 * and never a PIN.
 */
export const invitationsDispatchPayloadSchema = z.object({
  orderId: z.string().uuid(),
  /**
   * Restrict the run to specific sessions (per-session resend). Omitted =
   * every eligible session on the order.
   */
  sessionIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  /**
   * Resend mode: target already-invited sessions and regenerate their PINs
   * (spec 05 "same token, regenerated PIN"). Default is first dispatch,
   * which skips already-invited sessions (idempotent).
   */
  resend: z.boolean().default(false),
  /** Admin user who requested the run — audit context only (worker runs as system). */
  requestedByUserId: z.string().uuid().nullable().default(null),
});

/**
 * Reminder-engine sweep (D6 — spec 13): repeatable hourly job registered in
 * apps/worker/src/repeatable-jobs.ts. The reminder service selects due
 * sessions itself (2-day spacing, 30-day stop, suppression, order state), so
 * the payload is empty — every run re-evaluates the whole population.
 */
export const remindersSweepPayloadSchema = z.object({});

/** Single source of truth mapping job name → payload schema. */
export const jobPayloadSchemas = {
  'health.ping': healthPingPayloadSchema,
  'maintenance.heartbeat': heartbeatPayloadSchema,
  'notifications.send': notificationSendPayloadSchema,
  'scoring.dispatch': scoringDispatchPayloadSchema,
  'invitations.dispatch': invitationsDispatchPayloadSchema,
  'reminders.sweep': remindersSweepPayloadSchema,
} as const;

export type JobName = keyof typeof jobPayloadSchemas;

export type JobPayload<N extends JobName> = z.infer<(typeof jobPayloadSchemas)[N]>;

export function isJobName(name: string): name is JobName {
  return name in jobPayloadSchemas;
}
