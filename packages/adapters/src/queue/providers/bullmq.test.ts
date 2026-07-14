import { describe, expect, it, vi } from 'vitest';
import { BullMqJobQueue } from './bullmq';
import { JobQueueError } from '../types';

function makeQueueDouble() {
  return { add: vi.fn(async () => ({ id: 'job-1' })) };
}

describe('BullMqJobQueue', () => {
  it('validates the payload against the domain schema and adds the job', async () => {
    const queue = makeQueueDouble();
    const jobQueue = new BullMqJobQueue({ queue });

    const result = await jobQueue.enqueue('health.ping', {
      requestedAt: '2026-07-14T09:00:00.000Z',
      source: 'test',
    });

    expect(result).toEqual({ jobId: 'job-1' });
    expect(queue.add).toHaveBeenCalledWith(
      'health.ping',
      { requestedAt: '2026-07-14T09:00:00.000Z', source: 'test' },
      {}
    );
  });

  it('maps delayMs and idempotencyKey to BullMQ delay and jobId', async () => {
    const queue = makeQueueDouble();
    const jobQueue = new BullMqJobQueue({ queue });

    await jobQueue.enqueue(
      'health.ping',
      { requestedAt: '2026-07-14T09:00:00.000Z', source: 'test' },
      { delayMs: 60_000, idempotencyKey: 'ping:abc' }
    );

    expect(queue.add).toHaveBeenCalledWith('health.ping', expect.anything(), {
      delay: 60_000,
      jobId: 'ping:abc',
    });
  });

  it('rejects invalid payloads without touching the queue', async () => {
    const queue = makeQueueDouble();
    const jobQueue = new BullMqJobQueue({ queue });

    await expect(
      jobQueue.enqueue('health.ping', {
        requestedAt: 'not-a-timestamp',
        source: '',
      })
    ).rejects.toBeInstanceOf(JobQueueError);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('wraps transport failures in JobQueueError', async () => {
    const queue = { add: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) };
    const jobQueue = new BullMqJobQueue({ queue });

    await expect(
      jobQueue.enqueue('maintenance.heartbeat', {})
    ).rejects.toThrowError(/ECONNREFUSED/);
  });
});
