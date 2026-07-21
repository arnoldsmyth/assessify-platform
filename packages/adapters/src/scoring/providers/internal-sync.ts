import {
  internalScoringDefinitionSchema,
  scoreSetSchema,
  type ScoreSet,
} from '@assessify/domain';

import {
  ScoringAdapterError,
  type ScoringAdapter,
  type ScoringEngine,
  type ScoringInput,
  type ScoringOutcome,
} from '../types';

/**
 * `sync_internal` scoring provider (spec 08 "Internal engines"): platform-
 * owned pure scoring functions, selected by `scoring_config.engineKey`.
 *
 * Ships one built-in engine, `scale-sum-v1`, which executes the declarative
 * definition in `scoring_config.definition`: each dimension is the sum of the
 * numeric answers (likert/numeric values, matrix row values) of its
 * `questionKeys`, optionally mapped onto a band label key. Nothing here is
 * assessment-specific — richer engines (a ported PRO-D, ipsative scorers,
 * ...) register under their own `engineKey` via `options.engines`.
 *
 * Every engine result is re-validated against `scoreSetSchema` before it
 * leaves the adapter (Zod at the boundary).
 */

export const SCALE_SUM_ENGINE_KEY = 'scale-sum-v1';

function isRowValueRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'number')
  );
}

/** Built-in simple-scale-sum engine. Pure; exported for direct unit testing. */
export const scaleSumEngine: ScoringEngine = (input: ScoringInput): ScoreSet => {
  const parsed = internalScoringDefinitionSchema.safeParse(input.config.definition);
  if (!parsed.success) {
    throw new ScoringAdapterError(
      'scale-sum engine requires a valid scoring_config.definition',
      false
    );
  }

  const dimensions: Record<string, number> = {};
  const bands: Record<string, string> = {};
  for (const dimension of parsed.data.dimensions) {
    let sum = 0;
    for (const questionKey of dimension.questionKeys) {
      const value = input.answers[questionKey];
      if (typeof value === 'number') {
        sum += value;
      } else if (isRowValueRecord(value)) {
        // Matrix answer: every row contributes to the dimension.
        for (const rowValue of Object.values(value)) sum += rowValue;
      }
      // Option-key shapes (choice/ranking/ipsative) are not scale-summable —
      // engines that need them register under their own engineKey.
    }
    dimensions[dimension.key] = sum;
    const band = dimension.bands?.find((b) => sum >= b.min && sum <= b.max);
    if (band) bands[dimension.key] = band.key;
  }

  return {
    dimensions,
    ...(Object.keys(bands).length > 0 ? { bands } : {}),
  };
};

export interface InternalSyncScoringOptions {
  /** Additional engines keyed by `scoring_config.engineKey`. */
  engines?: Record<string, ScoringEngine>;
}

export function createInternalSyncScoringAdapter(
  options: InternalSyncScoringOptions = {}
): ScoringAdapter {
  const engines: Record<string, ScoringEngine> = {
    [SCALE_SUM_ENGINE_KEY]: scaleSumEngine,
    ...options.engines,
  };

  return {
    mode: 'sync_internal',
    async score(input: ScoringInput): Promise<ScoringOutcome> {
      const engineKey = input.config.engineKey ?? SCALE_SUM_ENGINE_KEY;
      const engine = engines[engineKey];
      if (!engine) {
        return { kind: 'failed', retryable: false, error: `unknown_engine:${engineKey}` };
      }
      try {
        const scores = scoreSetSchema.parse(await engine(input));
        return { kind: 'sync_result', scores };
      } catch (cause) {
        if (cause instanceof ScoringAdapterError) {
          return { kind: 'failed', retryable: cause.retryable, error: cause.message };
        }
        // Malformed engine output (ZodError) or an engine bug: retrying the
        // same pure function over the same immutable answers cannot succeed.
        return {
          kind: 'failed',
          retryable: false,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
  };
}
