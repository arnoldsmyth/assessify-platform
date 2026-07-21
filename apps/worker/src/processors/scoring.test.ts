import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { err, ok, type JobPayload } from '@assessify/domain';

import { createScoringDispatchProcessor } from './scoring';

const payload: JobPayload<'scoring.dispatch'> = {
  jobId: '01890a5d-ac96-774b-bcce-b302099a8057',
};

describe('scoring.dispatch processor', () => {
  it('hands the job id to the service and resolves on success', async () => {
    const processJob = vi
      .fn()
      .mockResolvedValue(ok({ jobId: payload.jobId, status: 'completed' }));
    const processor = createScoringDispatchProcessor({ service: { processJob } });
    await expect(processor(payload)).resolves.toBeUndefined();
    expect(processJob).toHaveBeenCalledWith(payload.jobId);
  });

  it('throws UnrecoverableError when the worker has no scoring service', async () => {
    const processor = createScoringDispatchProcessor({ service: undefined });
    await expect(processor(payload)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError for permanent failures (parked jobs)', async () => {
    for (const error of [
      { code: 'scoring/job_not_found', message: 'gone', detail: { permanent: true } },
      { code: 'scoring/failed', message: 'engine rejected', detail: { permanent: true } },
    ]) {
      const processJob = vi.fn().mockResolvedValue(err(error));
      const processor = createScoringDispatchProcessor({ service: { processJob } });
      await expect(processor(payload)).rejects.toBeInstanceOf(UnrecoverableError);
    }
  });

  it('throws a plain Error (retryable) for attempt failures', async () => {
    const processJob = vi.fn().mockResolvedValue(
      err({
        code: 'scoring/attempt_failed',
        message: 'engine timeout',
        detail: { attempts: 1, maxAttempts: 3 },
      })
    );
    const processor = createScoringDispatchProcessor({ service: { processJob } });
    await expect(processor(payload)).rejects.toThrow('scoring/attempt_failed');
    await expect(processor(payload)).rejects.not.toBeInstanceOf(UnrecoverableError);
  });
});
