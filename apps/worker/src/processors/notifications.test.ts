import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { err, ok, type JobPayload } from '@assessify/domain';

import { createNotificationSendProcessor } from './notifications';

const payload: JobPayload<'notifications.send'> = {
  notificationId: '01890a5d-ac96-774b-bcce-b302099a8057',
  message: {
    kind: 'invitation',
    to: 'respondent@example.com',
    subject: 'Your invitation',
    template: 'invitation',
    data: {},
    language: 'en',
    sender: { from: { name: 'Pro-D', address: 'assessments@pro-d.example' } },
    refs: {},
  },
};

describe('notifications.send processor', () => {
  it('hands the payload to the service and resolves on success', async () => {
    const deliverQueued = vi
      .fn()
      .mockResolvedValue(
        ok({ notificationId: payload.notificationId, status: 'sent', providerMessageId: 'm-1' })
      );
    const processor = createNotificationSendProcessor({ service: { deliverQueued } });
    await expect(processor(payload)).resolves.toBeUndefined();
    expect(deliverQueued).toHaveBeenCalledWith(payload);
  });

  it('throws UnrecoverableError when the worker has no notification service', async () => {
    const processor = createNotificationSendProcessor({ service: undefined });
    await expect(processor(payload)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError for permanent service failures', async () => {
    for (const error of [
      { code: 'notification/not_found', message: 'row missing', detail: { permanent: true } },
      {
        code: 'notification/send_failed',
        message: 'provider rejected',
        detail: { permanent: true },
      },
    ]) {
      const deliverQueued = vi.fn().mockResolvedValue(err(error));
      const processor = createNotificationSendProcessor({ service: { deliverQueued } });
      await expect(processor(payload)).rejects.toBeInstanceOf(UnrecoverableError);
    }
  });

  it('throws a plain Error (retryable) for transient failures without leaking PII', async () => {
    const deliverQueued = vi.fn().mockResolvedValue(
      err({
        code: 'notification/send_failed',
        message: 'provider 500',
        detail: { permanent: false },
      })
    );
    const processor = createNotificationSendProcessor({ service: { deliverQueued } });
    const thrown = await processor(payload).catch((e: unknown) => e as Error);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnrecoverableError);
    expect((thrown as Error).message).not.toContain('respondent@example.com');
  });
});
