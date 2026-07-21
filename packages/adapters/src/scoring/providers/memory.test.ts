import { scoringConfigSchema } from '@assessify/domain';
import { describe, expect, it } from 'vitest';

import type { ScoringFetchInput, ScoringInput } from '../types';
import { createMemoryScoringAdapter } from './memory';

function input(): ScoringInput {
  return {
    jobId: '01890000-0000-7000-8000-000000000001',
    sessionId: '01890000-0000-7000-8000-00000000aaaa',
    product: { id: '01890000-0000-7000-8000-00000000cccc', externalIds: {} },
    questionnaire: { key: 'test-def', version: 1, variant: 'self' },
    answers: { q1: 3 },
    config: scoringConfigSchema.parse({ mode: 'sync_internal' }),
  };
}

function fetchInput(): ScoringFetchInput {
  const { jobId, sessionId, product, config } = input();
  return { jobId, sessionId, product, config };
}

describe('memory scoring adapter (contract reference)', () => {
  it('records score() inputs and returns a benign default outcome', async () => {
    const adapter = createMemoryScoringAdapter();
    expect(adapter.mode).toBe('sync_internal');
    const outcome = await adapter.score(input());
    expect(outcome).toEqual({ kind: 'sync_result', scores: { dimensions: {} } });
    expect(adapter.scored).toHaveLength(1);
    expect(adapter.scored[0]?.jobId).toBe(input().jobId);
  });

  it('replays programmed outcomes FIFO, then falls back to the default', async () => {
    const adapter = createMemoryScoringAdapter({ mode: 'async_external' });
    adapter.queueOutcome({ kind: 'accepted_async', retrieval: 'callback' });
    adapter.queueOutcome({ kind: 'failed', retryable: true, error: 'boom' });
    expect(adapter.mode).toBe('async_external');
    await expect(adapter.score(input())).resolves.toEqual({
      kind: 'accepted_async',
      retrieval: 'callback',
    });
    await expect(adapter.score(input())).resolves.toEqual({
      kind: 'failed',
      retryable: true,
      error: 'boom',
    });
    await expect(adapter.score(input())).resolves.toEqual({
      kind: 'sync_result',
      scores: { dimensions: {} },
    });
  });

  it('implements pull retrieval: fetchResult defaults to pending', async () => {
    const adapter = createMemoryScoringAdapter({ mode: 'async_external' });
    adapter.queueFetchOutcome({ kind: 'result', scores: { dimensions: { drive: 7 } } });
    await expect(adapter.fetchResult?.(fetchInput())).resolves.toEqual({
      kind: 'result',
      scores: { dimensions: { drive: 7 } },
    });
    await expect(adapter.fetchResult?.(fetchInput())).resolves.toEqual({ kind: 'pending' });
    expect(adapter.fetched).toHaveLength(2);
  });

  it('can be told to fail and can be reset', async () => {
    const adapter = createMemoryScoringAdapter();
    adapter.failWith(new Error('engine offline'));
    await expect(adapter.score(input())).rejects.toThrow('engine offline');
    adapter.reset();
    await expect(adapter.score(input())).resolves.toEqual({
      kind: 'sync_result',
      scores: { dimensions: {} },
    });
    adapter.reset();
    expect(adapter.scored).toHaveLength(0);
  });
});
