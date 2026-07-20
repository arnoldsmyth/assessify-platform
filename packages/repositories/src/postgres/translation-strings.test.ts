import type { Database } from '@assessify/db';
import { uuidv7 } from '@assessify/domain';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { createTranslationStringRepository } from './translation-strings';

const PRODUCT_ID = uuidv7();
const now = new Date('2026-07-20T12:00:00.000Z');

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    productId: PRODUCT_ID,
    stringKey: 'q1.text',
    language: 'en',
    value: 'Question one',
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Chainable double for the Drizzle query builder — records the values passed
 * to insert and resolves the configured rows from the terminal call
 * (`.returning()` / awaited `.where()` / `.orderBy()`).
 */
function makeDbDouble(options: {
  selectRows?: unknown[];
  insertRows?: unknown[];
  deleteRows?: unknown[];
}) {
  const calls: { insertValues?: Record<string, unknown>[] } = {};

  const selectResult = Promise.resolve(options.selectRows ?? []);
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => selectResult),
      })),
    })),
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => options.selectRows ?? []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>[]) => {
        calls.insertValues = values;
        return {
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(async () => options.insertRows ?? []),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => options.deleteRows ?? []),
      })),
    })),
  };

  return { db: db as unknown as Database, raw: db, calls };
}

describe('createTranslationStringRepository.upsertMany', () => {
  it('bulk-inserts all keys and maps returned rows to Zod-validated entities', async () => {
    const returned = [makeRow(), makeRow({ stringKey: 'q2.text', value: 'Question two' })];
    const { db, calls } = makeDbDouble({ insertRows: returned });
    const repo = createTranslationStringRepository(db);

    const result = await repo.upsertMany(
      PRODUCT_ID,
      'en',
      { 'q1.text': 'Question one', 'q2.text': 'Question two' },
      now
    );

    expect(calls.insertValues).toEqual([
      { productId: PRODUCT_ID, stringKey: 'q1.text', language: 'en', value: 'Question one', updatedAt: now },
      { productId: PRODUCT_ID, stringKey: 'q2.text', language: 'en', value: 'Question two', updatedAt: now },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      productId: PRODUCT_ID,
      stringKey: 'q1.text',
      language: 'en',
      value: 'Question one',
      updatedAt: now,
    });
  });

  it('is a no-op for an empty strings map', async () => {
    const { db, raw } = makeDbDouble({});
    const repo = createTranslationStringRepository(db);

    const result = await repo.upsertMany(PRODUCT_ID, 'en', {});

    expect(result).toEqual([]);
    expect(raw.insert).not.toHaveBeenCalled();
  });

  it('rejects malformed rows coming back from the database', async () => {
    const { db } = makeDbDouble({ insertRows: [makeRow({ productId: 'not-a-uuid' })] });
    const repo = createTranslationStringRepository(db);

    await expect(repo.upsertMany(PRODUCT_ID, 'en', { 'q1.text': 'x' })).rejects.toThrow(ZodError);
  });
});

describe('createTranslationStringRepository.findByLanguage', () => {
  it('maps rows to Zod-validated entities', async () => {
    const { db } = makeDbDouble({ selectRows: [makeRow()] });
    const repo = createTranslationStringRepository(db);

    const result = await repo.findByLanguage(PRODUCT_ID, 'en');

    expect(result).toEqual([
      { productId: PRODUCT_ID, stringKey: 'q1.text', language: 'en', value: 'Question one', updatedAt: now },
    ]);
  });

  it('short-circuits an explicitly empty key set without querying', async () => {
    const { db, raw } = makeDbDouble({ selectRows: [makeRow()] });
    const repo = createTranslationStringRepository(db);

    const result = await repo.findByLanguage(PRODUCT_ID, 'en', []);

    expect(result).toEqual([]);
    expect(raw.select).not.toHaveBeenCalled();
  });
});

describe('createTranslationStringRepository.listLanguages', () => {
  it('returns the distinct language column values', async () => {
    const { db } = makeDbDouble({ selectRows: [{ language: 'en' }, { language: 'fr' }] });
    const repo = createTranslationStringRepository(db);

    await expect(repo.listLanguages(PRODUCT_ID)).resolves.toEqual(['en', 'fr']);
  });
});

describe('createTranslationStringRepository.deleteKeys', () => {
  it('returns the number of rows deleted', async () => {
    const { db } = makeDbDouble({ deleteRows: [{ stringKey: 'q1.text' }, { stringKey: 'q2.text' }] });
    const repo = createTranslationStringRepository(db);

    await expect(repo.deleteKeys(PRODUCT_ID, 'en', ['q1.text', 'q2.text'])).resolves.toBe(2);
  });

  it('is a no-op for an empty key list', async () => {
    const { db, raw } = makeDbDouble({});
    const repo = createTranslationStringRepository(db);

    await expect(repo.deleteKeys(PRODUCT_ID, 'en', [])).resolves.toBe(0);
    expect(raw.delete).not.toHaveBeenCalled();
  });
});
