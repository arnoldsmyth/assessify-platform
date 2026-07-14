import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { dispatchJob } from './dispatch';
import type { ProcessorRegistry } from './processors';

function makeRegistry(overrides: Partial<ProcessorRegistry> = {}): ProcessorRegistry {
  return {
    'health.ping': vi.fn(async () => undefined),
    'maintenance.heartbeat': vi.fn(async () => undefined),
    ...overrides,
  };
}

const validPing = { requestedAt: '2026-07-14T09:00:00.000Z', source: 'test' };

describe('dispatchJob', () => {
  it('parses the payload and calls the matching processor', async () => {
    const registry = makeRegistry();

    await dispatchJob(registry, { name: 'health.ping', data: validPing });

    expect(registry['health.ping']).toHaveBeenCalledExactlyOnceWith(validPing);
    expect(registry['maintenance.heartbeat']).not.toHaveBeenCalled();
  });

  it('rejects unknown job names with UnrecoverableError (no retries)', async () => {
    const registry = makeRegistry();

    await expect(
      dispatchJob(registry, { name: 'nope.unknown', data: {} })
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('rejects invalid payloads with UnrecoverableError before the processor runs', async () => {
    const registry = makeRegistry();

    await expect(
      dispatchJob(registry, {
        name: 'health.ping',
        data: { requestedAt: 'garbage', source: 42 },
      })
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(registry['health.ping']).not.toHaveBeenCalled();
  });

  it('lets processor errors propagate as plain errors (retryable)', async () => {
    const registry = makeRegistry({
      'health.ping': vi.fn(async () => {
        throw new Error('downstream flake');
      }),
    });

    const attempt = dispatchJob(registry, { name: 'health.ping', data: validPing });
    await expect(attempt).rejects.toThrowError('downstream flake');
    await expect(attempt).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});
