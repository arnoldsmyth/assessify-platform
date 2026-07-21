import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { err, ok, type JobPayload } from '@assessify/domain';
import type { InvitationDispatchSummary } from '@assessify/services';

import { createInvitationsDispatchProcessor } from './invitations';

const payload: JobPayload<'invitations.dispatch'> = {
  orderId: '01890a5d-ac96-774b-bcce-b302099a0001',
  resend: false,
  requestedByUserId: null,
};

const summary: InvitationDispatchSummary = {
  orderId: payload.orderId,
  mode: 'dispatch',
  sent: 2,
  suppressed: 0,
  skipped: 0,
  failed: [],
  orderTransition: 'invitations_sent',
};

describe('invitations.dispatch processor', () => {
  it('hands the payload to the invitation service and resolves on success', async () => {
    const dispatch = vi.fn().mockResolvedValue(ok(summary));
    const processor = createInvitationsDispatchProcessor({ service: { dispatch } });
    await expect(processor(payload)).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledWith(payload);
  });

  it('throws UnrecoverableError when the worker has no invitation service', async () => {
    const processor = createInvitationsDispatchProcessor({ service: undefined });
    await expect(processor(payload)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError for permanent failures (order gone, silent mode)', async () => {
    for (const error of [
      { code: 'invitation/order_not_found', message: 'gone', detail: { permanent: true } },
      {
        code: 'invitation/notifications_suppressed',
        message: 'silent mode',
        detail: { permanent: true },
      },
    ]) {
      const dispatch = vi.fn().mockResolvedValue(err(error));
      const processor = createInvitationsDispatchProcessor({ service: { dispatch } });
      await expect(processor(payload)).rejects.toBeInstanceOf(UnrecoverableError);
    }
  });

  it('throws a plain Error (retryable) for transient failures', async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValue(err({ code: 'invitation/storage_failed', message: 'db down' }));
    const processor = createInvitationsDispatchProcessor({ service: { dispatch } });
    const thrown = await processor(payload).catch((e: unknown) => e as Error);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnrecoverableError);
  });
});
