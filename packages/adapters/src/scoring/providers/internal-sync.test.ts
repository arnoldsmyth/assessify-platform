import { scoringConfigSchema, type ScoringConfig } from '@assessify/domain';
import { describe, expect, it } from 'vitest';

import { ScoringAdapterError, type ScoringInput } from '../types';
import { createInternalSyncScoringAdapter, SCALE_SUM_ENGINE_KEY } from './internal-sync';

function config(overrides: Record<string, unknown> = {}): ScoringConfig {
  return scoringConfigSchema.parse({
    mode: 'sync_internal',
    definition: {
      dimensions: [
        {
          key: 'drive',
          questionKeys: ['q1', 'q2', 'q_matrix'],
          bands: [
            { key: 'low', min: 0, max: 9 },
            { key: 'high', min: 10, max: 99 },
          ],
        },
        { key: 'calm', questionKeys: ['q3'] },
      ],
    },
    ...overrides,
  });
}

function input(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    jobId: '01890000-0000-7000-8000-000000000001',
    sessionId: '01890000-0000-7000-8000-00000000aaaa',
    product: { id: '01890000-0000-7000-8000-00000000cccc', externalIds: {} },
    questionnaire: { key: 'test-def', version: 1, variant: 'self' },
    answers: {
      q1: 4,
      q2: 3,
      q_matrix: { r1: 2, r2: 3 }, // matrix rows sum into the dimension
      q3: 1,
      q_choice: ['a', 'b'], // option keys: ignored by scale-sum
    },
    config: config(),
    ...overrides,
  };
}

describe('internal-sync scoring adapter (scale-sum-v1)', () => {
  const adapter = createInternalSyncScoringAdapter();

  it('serves the sync_internal mode', () => {
    expect(adapter.mode).toBe('sync_internal');
    expect(adapter.fetchResult).toBeUndefined();
  });

  it('sums numeric answers per dimension and maps bands', async () => {
    const outcome = await adapter.score(input());
    expect(outcome).toEqual({
      kind: 'sync_result',
      scores: {
        dimensions: { drive: 12, calm: 1 }, // 4 + 3 + (2 + 3); calm has no bands
        bands: { drive: 'high' },
      },
    });
  });

  it('treats unanswered question keys as contributing nothing', async () => {
    const outcome = await adapter.score(input({ answers: { q1: 2 } }));
    expect(outcome).toEqual({
      kind: 'sync_result',
      scores: { dimensions: { drive: 2, calm: 0 }, bands: { drive: 'low' } },
    });
  });

  it('fails non-retryably when the definition is missing', async () => {
    const outcome = await adapter.score(
      input({ config: scoringConfigSchema.parse({ mode: 'sync_internal' }) })
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.retryable).toBe(false);
  });

  it('fails non-retryably for an unknown engine key', async () => {
    const outcome = await adapter.score(
      input({ config: config({ engineKey: 'pro-d-v9' }) })
    );
    expect(outcome).toEqual({
      kind: 'failed',
      retryable: false,
      error: 'unknown_engine:pro-d-v9',
    });
  });

  it('runs a registered custom engine and validates its output', async () => {
    const custom = createInternalSyncScoringAdapter({
      engines: {
        'custom-v1': () => ({ dimensions: { x: 1 } }),
        'broken-v1': () => ({ dimensions: { x: Number.NaN } }),
        'throwing-v1': () => {
          throw new ScoringAdapterError('engine store offline', true);
        },
      },
    });
    await expect(custom.score(input({ config: config({ engineKey: 'custom-v1' }) }))).resolves.toEqual(
      { kind: 'sync_result', scores: { dimensions: { x: 1 } } }
    );
    // Malformed ScoreSet → non-retryable failure (Zod boundary).
    const broken = await custom.score(input({ config: config({ engineKey: 'broken-v1' }) }));
    expect(broken.kind).toBe('failed');
    if (broken.kind !== 'failed') return;
    expect(broken.retryable).toBe(false);
    // ScoringAdapterError keeps its retryable flag.
    const thrown = await custom.score(input({ config: config({ engineKey: 'throwing-v1' }) }));
    expect(thrown).toEqual({ kind: 'failed', retryable: true, error: 'engine store offline' });
  });

  it('uses the scale-sum engine by default', async () => {
    expect(SCALE_SUM_ENGINE_KEY).toBe('scale-sum-v1');
    const explicit = await adapter.score(
      input({ config: config({ engineKey: SCALE_SUM_ENGINE_KEY }) })
    );
    const implicit = await adapter.score(input());
    expect(explicit).toEqual(implicit);
  });
});
