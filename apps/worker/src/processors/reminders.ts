/**
 * `reminders.sweep` processor (D6 — spec 13): parse job → call the reminder
 * service, which selects due sessions (2-day spacing, 30-day stop,
 * suppression, order state), stamps them with a guarded update and sends
 * reminder emails through the notification service.
 *
 * Processors stay thin (03-architecture.md): call the service, map its
 * Result. The job is a repeatable hourly schedule, so a failed run simply
 * reports and the next tick re-evaluates the whole population — nothing is
 * lost. Error mapping mirrors invitations.ts:
 * - service unavailable / permanent errors → `UnrecoverableError`;
 * - anything else → normal throw, retried per queue backoff.
 *
 * Log lines carry counts and session ids only — never recipients.
 */
import { UnrecoverableError } from 'bullmq';
import type { JobPayload } from '@assessify/domain';
import type { ReminderService } from '@assessify/services';

export interface RemindersDeps {
  /** Undefined when the worker booted without DATABASE_URL (dev without a DB). */
  service: Pick<ReminderService, 'sweep'> | undefined;
}

export function createRemindersSweepProcessor(deps: RemindersDeps) {
  return async (_payload: JobPayload<'reminders.sweep'>): Promise<void> => {
    if (!deps.service) {
      throw new UnrecoverableError(
        'reminders.sweep: reminder service not configured (set DATABASE_URL)'
      );
    }
    const result = await deps.service.sweep();
    if (!result.ok) {
      const permanent = result.error.detail?.['permanent'] === true;
      const message = `reminders.sweep: ${result.error.code}`;
      if (permanent) throw new UnrecoverableError(message);
      throw new Error(message);
    }
    const s = result.value;
    console.log(
      `[worker] reminders.sweep: sent=${s.sent} skipped=${s.skipped} deferred=${s.deferred} failed=${s.failed.length}`
    );
  };
}
