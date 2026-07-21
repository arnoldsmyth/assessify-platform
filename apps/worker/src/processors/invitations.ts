/**
 * `invitations.dispatch` processor (D5 — spec 06/05/13): parse job → call the
 * invitation service, which generates+hashes PINs, sends invitation emails
 * through the notification service, and drives the order state machine.
 *
 * Processors stay thin (03-architecture.md): call the service, map its
 * Result. Error mapping mirrors notifications.ts:
 * - service unavailable / order or product gone / silent-mode order →
 *   `UnrecoverableError` (`detail.permanent`), parked in the failed set;
 * - anything else → normal throw, retried per queue backoff. Re-runs are
 *   safe: dispatch skips sessions already marked invited.
 *
 * Log lines carry ids and counts only — never recipients, never PINs.
 */
import { UnrecoverableError } from 'bullmq';
import type { JobPayload } from '@assessify/domain';
import type { InvitationService } from '@assessify/services';

export interface InvitationsDeps {
  /** Undefined when the worker booted without DATABASE_URL (dev without a DB). */
  service: Pick<InvitationService, 'dispatch'> | undefined;
}

export function createInvitationsDispatchProcessor(deps: InvitationsDeps) {
  return async (payload: JobPayload<'invitations.dispatch'>): Promise<void> => {
    if (!deps.service) {
      throw new UnrecoverableError(
        'invitations.dispatch: invitation service not configured (set DATABASE_URL)'
      );
    }
    const result = await deps.service.dispatch(payload);
    if (!result.ok) {
      const permanent = result.error.detail?.['permanent'] === true;
      const message = `invitations.dispatch ${payload.orderId}: ${result.error.code}`;
      if (permanent) throw new UnrecoverableError(message);
      throw new Error(message);
    }
    const s = result.value;
    console.log(
      `[worker] invitations.dispatch ${s.orderId} (${s.mode}): sent=${s.sent} suppressed=${s.suppressed} skipped=${s.skipped} failed=${s.failed.length} transition=${s.orderTransition ?? 'none'}`
    );
  };
}
