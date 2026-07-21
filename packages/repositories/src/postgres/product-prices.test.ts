import type { Database } from '@assessify/db';
import { uuidv7 } from '@assessify/domain';
import { describe, expect, it, vi } from 'vitest';

import { createProductPriceRepository } from './product-prices';

const PRODUCT_ID = uuidv7();
const PRICE_ID = uuidv7();
const now = new Date('2026-07-21T12:00:00.000Z');

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRICE_ID,
    productId: PRODUCT_ID,
    language: 'en',
    currency: 'EUR',
    unitPrice: 12500,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Chainable double for the Drizzle query builder — records the values passed
 * to insert and resolves the configured rows from the terminal call.
 */
function makeDbDouble(options: {
  selectRows?: unknown[];
  insertRows?: unknown[];
  deleteRows?: unknown[];
}) {
  const calls: { insertValues?: Record<string, unknown> } = {};

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => options.selectRows ?? []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
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

describe('createProductPriceRepository.upsert', () => {
  it('inserts with conflict-update semantics and maps the returned row', async () => {
    const { db, calls } = makeDbDouble({ insertRows: [makeRow()] });
    const repo = createProductPriceRepository(db);

    const result = await repo.upsert({
      id: PRICE_ID,
      productId: PRODUCT_ID,
      language: 'en',
      currency: 'EUR',
      unitPrice: 12500,
      timestamp: now,
    });

    expect(calls.insertValues).toEqual({
      id: PRICE_ID,
      productId: PRODUCT_ID,
      language: 'en',
      currency: 'EUR',
      unitPrice: 12500,
      createdAt: now,
      updatedAt: now,
    });
    expect(result).toEqual({
      id: PRICE_ID,
      productId: PRODUCT_ID,
      language: 'en',
      currency: 'EUR',
      unitPrice: 12500,
      createdAt: now,
      updatedAt: now,
    });
  });

  it('throws when the upsert returns no row (infrastructure failure)', async () => {
    const { db } = makeDbDouble({ insertRows: [] });
    const repo = createProductPriceRepository(db);

    await expect(
      repo.upsert({
        id: PRICE_ID,
        productId: PRODUCT_ID,
        language: 'en',
        currency: 'EUR',
        unitPrice: 12500,
        timestamp: now,
      })
    ).rejects.toThrow('Upsert into product_prices returned no row');
  });
});

describe('createProductPriceRepository.listByProduct', () => {
  it('maps rows to entities', async () => {
    const { db } = makeDbDouble({ selectRows: [makeRow(), makeRow({ language: 'es' })] });
    const repo = createProductPriceRepository(db);

    const result = await repo.listByProduct(PRODUCT_ID);

    expect(result).toHaveLength(2);
    expect(result[1]?.language).toBe('es');
  });
});

describe('createProductPriceRepository.delete', () => {
  it('reports whether a row was deleted', async () => {
    const hit = createProductPriceRepository(
      makeDbDouble({ deleteRows: [{ id: PRICE_ID }] }).db
    );
    await expect(hit.delete(PRODUCT_ID, 'en', 'EUR')).resolves.toBe(true);

    const miss = createProductPriceRepository(makeDbDouble({ deleteRows: [] }).db);
    await expect(miss.delete(PRODUCT_ID, 'en', 'EUR')).resolves.toBe(false);
  });
});
