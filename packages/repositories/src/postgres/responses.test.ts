import type { Database } from '@assessify/db';
import { uuidv7 } from '@assessify/domain';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { DrizzleResponseRepository } from './responses';

const answeredAt = '2026-07-14T09:00:00.000Z';
const now = new Date(answeredAt);

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: uuidv7(),
    sessionId: uuidv7(),
    orderId: uuidv7(),
    productId: uuidv7(),
    questionnaireVersionId: uuidv7(),
    language: 'en',
    status: 'draft',
    answers: { q1: { type: 'likert', value: 3, answeredAt } },
    progress: { currentSectionKey: 'core', answeredCount: 1, totalCount: 10 },
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Chainable double for the Drizzle query builder — records the values passed
 * to insert/update and resolves the configured rows from `.returning()` /
 * `.limit()`.
 */
function makeDbDouble(options: {
  selectRows?: unknown[];
  insertRows?: unknown[];
  updateRows?: unknown[];
}) {
  const calls: { insertValues?: Record<string, unknown>; updateSet?: Record<string, unknown> } = {};

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => options.selectRows ?? []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        calls.insertValues = values;
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => options.insertRows ?? []),
          })),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        calls.updateSet = values;
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => options.updateRows ?? []),
          })),
        };
      }),
    })),
  };

  return { db: db as unknown as Database, raw: db, calls };
}

describe('DrizzleResponseRepository.findBySessionId', () => {
  it('maps a row to a Zod-validated domain entity', async () => {
    const row = makeRow();
    const { db } = makeDbDouble({ selectRows: [row] });
    const repo = new DrizzleResponseRepository(db);

    const entity = await repo.findBySessionId(row.sessionId as string);
    expect(entity).not.toBeNull();
    expect(entity?.sessionId).toBe(row.sessionId);
    expect(entity?.answers['q1']).toEqual({ type: 'likert', value: 3, answeredAt });
    expect(entity?.status).toBe('draft');
  });

  it('returns null when the session has no response', async () => {
    const { db } = makeDbDouble({ selectRows: [] });
    const repo = new DrizzleResponseRepository(db);
    expect(await repo.findBySessionId(uuidv7())).toBeNull();
  });

  it('throws when a stored jsonb payload is corrupt (validation on the way out)', async () => {
    const row = makeRow({ answers: { q1: { type: 'likert', value: 'three', answeredAt } } });
    const { db } = makeDbDouble({ selectRows: [row] });
    const repo = new DrizzleResponseRepository(db);
    await expect(repo.findBySessionId(row.sessionId as string)).rejects.toBeInstanceOf(ZodError);
  });
});

describe('DrizzleResponseRepository.getOrCreate', () => {
  const input = {
    id: uuidv7(),
    sessionId: uuidv7(),
    orderId: uuidv7(),
    productId: uuidv7(),
    questionnaireVersionId: uuidv7(),
    language: 'pt-BR',
  };

  it('inserts a fresh empty draft', async () => {
    const inserted = makeRow({ ...input, answers: {}, language: 'pt-BR' });
    const { db, calls } = makeDbDouble({ insertRows: [inserted] });
    const repo = new DrizzleResponseRepository(db);

    const entity = await repo.getOrCreate(input);
    expect(entity.id).toBe(inserted.id);
    expect(calls.insertValues).toMatchObject({
      sessionId: input.sessionId,
      status: 'draft',
      answers: {},
      progress: { currentSectionKey: null, answeredCount: 0, totalCount: 0 },
      completedAt: null,
    });
  });

  it('falls back to the existing row on session_id conflict (resume)', async () => {
    const existing = makeRow({ sessionId: input.sessionId });
    const { db } = makeDbDouble({ insertRows: [], selectRows: [existing] });
    const repo = new DrizzleResponseRepository(db);

    const entity = await repo.getOrCreate(input);
    expect(entity.id).toBe(existing.id);
  });

  it('rejects invalid creation payloads before touching the db', async () => {
    const { db, raw } = makeDbDouble({});
    const repo = new DrizzleResponseRepository(db);
    await expect(
      repo.getOrCreate({ ...input, sessionId: 'not-a-uuid' })
    ).rejects.toBeInstanceOf(ZodError);
    expect(raw.insert).not.toHaveBeenCalled();
  });
});

describe('DrizzleResponseRepository.patchAnswers', () => {
  const patch = {
    q2: { type: 'ipsative_most_least' as const, value: { most: 'a', least: 'b' }, answeredAt },
  };

  it('merges the patch via a top-level jsonb || and returns the updated entity', async () => {
    const updated = makeRow({ answers: { ...makeRow().answers, ...patch } });
    const { db, calls } = makeDbDouble({ updateRows: [updated] });
    const repo = new DrizzleResponseRepository(db);

    const entity = await repo.patchAnswers(updated.sessionId as string, patch);
    expect(entity?.answers['q2']).toEqual(patch.q2);
    // answers is set to a SQL expression (jsonb merge), not a plain object.
    expect(calls.updateSet?.answers).toBeTypeOf('object');
    expect(calls.updateSet?.answers).not.toEqual(patch);
    expect(calls.updateSet?.updatedAt).toBeInstanceOf(Date);
  });

  it('returns null when there is no draft response (missing or submitted)', async () => {
    const { db } = makeDbDouble({ updateRows: [] });
    const repo = new DrizzleResponseRepository(db);
    expect(await repo.patchAnswers(uuidv7(), patch)).toBeNull();
  });

  it('rejects malformed or empty patches without touching the db', async () => {
    const { db, raw } = makeDbDouble({});
    const repo = new DrizzleResponseRepository(db);

    await expect(repo.patchAnswers(uuidv7(), {})).rejects.toBeInstanceOf(ZodError);
    await expect(
      repo.patchAnswers(uuidv7(), {
        q1: { type: 'likert', value: 'high', answeredAt } as never,
      })
    ).rejects.toBeInstanceOf(ZodError);
    expect(raw.update).not.toHaveBeenCalled();
  });
});

describe('DrizzleResponseRepository.updateProgress', () => {
  const progress = { currentSectionKey: 'values', answeredCount: 8, totalCount: 20 };

  it('replaces the progress snapshot and optionally the language', async () => {
    const updated = makeRow({ progress, language: 'fr' });
    const { db, calls } = makeDbDouble({ updateRows: [updated] });
    const repo = new DrizzleResponseRepository(db);

    const entity = await repo.updateProgress(updated.sessionId as string, progress, {
      language: 'fr',
    });
    expect(entity?.progress).toEqual(progress);
    expect(calls.updateSet).toMatchObject({ progress, language: 'fr' });
  });

  it('leaves language untouched when not provided', async () => {
    const updated = makeRow({ progress });
    const { db, calls } = makeDbDouble({ updateRows: [updated] });
    const repo = new DrizzleResponseRepository(db);

    await repo.updateProgress(updated.sessionId as string, progress);
    expect(calls.updateSet).not.toHaveProperty('language');
  });

  it('rejects invalid progress payloads', async () => {
    const { db } = makeDbDouble({});
    const repo = new DrizzleResponseRepository(db);
    await expect(
      repo.updateProgress(uuidv7(), { currentSectionKey: 's', answeredCount: -1, totalCount: 2 })
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe('DrizzleResponseRepository.markSubmitted', () => {
  it('transitions draft → submitted with completedAt', async () => {
    const completedAt = new Date('2026-07-15T10:30:00.000Z');
    const updated = makeRow({ status: 'submitted', completedAt, updatedAt: completedAt });
    const { db, calls } = makeDbDouble({ updateRows: [updated] });
    const repo = new DrizzleResponseRepository(db);

    const entity = await repo.markSubmitted(updated.sessionId as string, completedAt);
    expect(entity?.status).toBe('submitted');
    expect(entity?.completedAt).toEqual(completedAt);
    expect(calls.updateSet).toMatchObject({ status: 'submitted', completedAt });
  });

  it('returns null when already submitted (exactly-once guard)', async () => {
    const { db } = makeDbDouble({ updateRows: [] });
    const repo = new DrizzleResponseRepository(db);
    expect(await repo.markSubmitted(uuidv7())).toBeNull();
  });
});
