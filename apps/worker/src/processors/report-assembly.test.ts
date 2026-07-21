import { UnrecoverableError } from 'bullmq';
import { err, ok } from '@assessify/domain';
import { describe, expect, it, vi } from 'vitest';

import { createReportAssembleProcessor } from './report-assembly';

const SESSION_ID = '01890000-0000-7000-8000-00000000aa01';

const receipt = {
  reportId: '01890000-0000-7000-8000-00000000ab01',
  sessionId: SESSION_ID,
  orderId: '01890000-0000-7000-8000-00000000bb01',
  status: 'ready' as const,
  unknownPlaceholders: [],
};

describe('report.assemble processor', () => {
  it('hands the session id to reportService.assemble', async () => {
    const assemble = vi.fn(async () => ok(receipt));
    const processor = createReportAssembleProcessor({ service: { assemble } });

    await processor({ sessionId: SESSION_ID });

    expect(assemble).toHaveBeenCalledExactlyOnceWith(SESSION_ID);
  });

  it('parks unrecoverably when the service is not configured', async () => {
    const processor = createReportAssembleProcessor({ service: undefined });
    await expect(processor({ sessionId: SESSION_ID })).rejects.toThrow(UnrecoverableError);
  });

  it('maps permanent failures (missing template) to UnrecoverableError', async () => {
    const assemble = vi.fn(async () =>
      err({
        code: 'report/template_missing',
        message: 'No report template is available for this product',
        detail: { permanent: true },
      })
    );
    const processor = createReportAssembleProcessor({ service: { assemble } });

    await expect(processor({ sessionId: SESSION_ID })).rejects.toThrow(UnrecoverableError);
    await expect(
      createReportAssembleProcessor({ service: { assemble } })({ sessionId: SESSION_ID })
    ).rejects.toThrow('report/template_missing');
  });

  it('throws a normal (retryable) error for transient failures', async () => {
    const assemble = vi.fn(async () =>
      err({ code: 'report/storage_failed', message: 'S3 write failed' })
    );
    const processor = createReportAssembleProcessor({ service: { assemble } });

    const failure = await processor({ sessionId: SESSION_ID }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UnrecoverableError);
    expect((failure as Error).message).toContain('report/storage_failed');
  });
});
