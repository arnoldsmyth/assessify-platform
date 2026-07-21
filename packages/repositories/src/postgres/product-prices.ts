import { productPrices, type Database } from '@assessify/db';
import type { ProductPrice } from '@assessify/domain';
import { and, asc, eq } from 'drizzle-orm';

/**
 * Data access for `product_prices` — the org-set price list keyed
 * (product, language, currency), integer minor units (M1/M2, owner decisions
 * 2026-07-21). Upsert semantics: one row per key, price overwritten in place.
 */

export interface UpsertProductPriceRow {
  /** Used only when no row exists yet for (product, language, currency). */
  id: string;
  productId: string;
  language: string;
  currency: string;
  unitPrice: number;
  timestamp: Date;
}

export interface ProductPriceRepository {
  /** Prices for one product, language then currency A→Z. */
  listByProduct(productId: string): Promise<ProductPrice[]>;
  upsert(row: UpsertProductPriceRow): Promise<ProductPrice>;
  /** Returns true when a row was deleted. */
  delete(productId: string, language: string, currency: string): Promise<boolean>;
}

type ProductPriceRow = typeof productPrices.$inferSelect;

function toEntity(row: ProductPriceRow): ProductPrice {
  return {
    id: row.id,
    productId: row.productId,
    language: row.language,
    currency: row.currency,
    unitPrice: row.unitPrice,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createProductPriceRepository(db: Database): ProductPriceRepository {
  return {
    async listByProduct(productId) {
      const rows = await db
        .select()
        .from(productPrices)
        .where(eq(productPrices.productId, productId))
        .orderBy(asc(productPrices.language), asc(productPrices.currency));
      return rows.map(toEntity);
    },

    async upsert(row) {
      const rows = await db
        .insert(productPrices)
        .values({
          id: row.id,
          productId: row.productId,
          language: row.language,
          currency: row.currency,
          unitPrice: row.unitPrice,
          createdAt: row.timestamp,
          updatedAt: row.timestamp,
        })
        .onConflictDoUpdate({
          target: [productPrices.productId, productPrices.language, productPrices.currency],
          set: { unitPrice: row.unitPrice, updatedAt: row.timestamp },
        })
        .returning();
      const returned = rows[0];
      if (!returned) throw new Error('Upsert into product_prices returned no row');
      return toEntity(returned);
    },

    async delete(productId, language, currency) {
      const rows = await db
        .delete(productPrices)
        .where(
          and(
            eq(productPrices.productId, productId),
            eq(productPrices.language, language),
            eq(productPrices.currency, currency)
          )
        )
        .returning({ id: productPrices.id });
      return rows.length > 0;
    },
  };
}
