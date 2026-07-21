import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@assessify/domain';
import type { ReminderSweepSummary } from '@assessify/services';

import { createProcessorRegistry } from './index';
import { createRemindersSweepProcessor } from './reminders';

const summary: ReminderSweepSummary = { sent: 3, skipped: 1, deferred: 2, failed: [] };

describe('reminders.sweep processor', () => {
  it('hands the sweep to the reminder service and resolves on success', async () => {
    const sweep = vi.fn().mockResolvedValue(ok(summary));
    const processor = createRemindersSweepProcessor({ service: { sweep } });
    await expect(processor({})).resolves.toBeUndefined();
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('throws UnrecoverableError when the worker has no reminder service', async () => {
    const processor = createRemindersSweepProcessor({ service: undefined });
    await expect(processor({})).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws a plain Error (retryable) for transient failures', async () => {
    const sweep = vi
      .fn()
      .mockResolvedValue(err({ code: 'reminder/storage_failed', message: 'db down' }));
    const processor = createRemindersSweepProcessor({ service: { sweep } });
    const thrown = await processor({}).catch((e: unknown) => e as Error);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError for permanent failures', async () => {
    const sweep = vi.fn().mockResolvedValue(
      err({ code: 'reminder/misconfigured', message: 'nope', detail: { permanent: true } })
    );
    const processor = createRemindersSweepProcessor({ service: { sweep } });
    await expect(processor({})).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('is wired into the processor registry under its job name', () => {
    const registry = createProcessorRegistry({
      health: {
        getHealth: vi.fn(() => ok({ status: 'ok' as const, timestamp: new Date().toISOString() })),
      },
      notifications: { service: undefined },
      scoring: { service: undefined },
      reports: { service: undefined },
      invitations: { service: undefined },
      reminders: { service: { sweep: vi.fn().mockResolvedValue(ok(summary)) } },
    });
    expect(typeof registry['reminders.sweep']).toBe('function');
  });
});
