import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@assessify/domain';
import { createHealthPingProcessor } from './health-ping';

const payload = { requestedAt: '2026-07-14T09:00:00.000Z', source: 'test' };

describe('health.ping processor', () => {
  it('calls the health service and resolves on an ok result', async () => {
    const getHealth = vi.fn(() =>
      ok({ status: 'ok' as const, timestamp: '2026-07-14T09:00:01.000Z' })
    );
    const process = createHealthPingProcessor({ getHealth });

    await expect(process(payload)).resolves.toBeUndefined();
    expect(getHealth).toHaveBeenCalledOnce();
  });

  it('throws (making BullMQ retry) when the service reports an error result', async () => {
    const getHealth = vi.fn(() =>
      err({ code: 'HEALTH_DEGRADED', message: 'not feeling great' })
    );
    const process = createHealthPingProcessor({ getHealth });

    await expect(process(payload)).rejects.toThrowError(/HEALTH_DEGRADED/);
  });
});
