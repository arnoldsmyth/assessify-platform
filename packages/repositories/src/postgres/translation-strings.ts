import { translationStrings, type Database } from '@assessify/db';
import { translationStringSchema, type TranslationString } from '@assessify/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * Data access for `translation_strings` (spec 04 catalogue, spec 07
 * localisation model). Composite PK (product_id, string_key, language) — an
 * import for a product+language is a bulk upsert keyed on it. Business rules
 * (who may import, language availability, default-language fallback) live in
 * the translation service, not here
 * (docs/spec/appendix-architecture-layers.md §2).
 */

export interface TranslationStringRepository {
  /**
   * Bulk upsert one product+language import: inserts new keys, overwrites the
   * value (and bumps updated_at) for existing ones. Returns the upserted rows.
   */
  upsertMany(
    productId: string,
    language: string,
    strings: Record<string, string>,
    updatedAt?: Date
  ): Promise<TranslationString[]>;
  /**
   * All strings for a product+language; `keys` narrows to that key set
   * (missing keys are simply absent from the result).
   */
  findByLanguage(
    productId: string,
    language: string,
    keys?: string[]
  ): Promise<TranslationString[]>;
  /** Distinct languages that have at least one string for the product, A→Z. */
  listLanguages(productId: string): Promise<string[]>;
  /** Delete the given keys for a product+language. Returns rows deleted. */
  deleteKeys(productId: string, language: string, keys: string[]): Promise<number>;
}

type TranslationStringRow = typeof translationStrings.$inferSelect;

/** Zod-validate on the way out — rows map to domain entities. */
function toEntity(row: TranslationStringRow): TranslationString {
  return translationStringSchema.parse({
    productId: row.productId,
    stringKey: row.stringKey,
    language: row.language,
    value: row.value,
    updatedAt: row.updatedAt,
  });
}

/** Rows per multi-value insert — keeps well under the pg parameter limit. */
const UPSERT_CHUNK = 500;

export function createTranslationStringRepository(db: Database): TranslationStringRepository {
  return {
    async upsertMany(productId, language, strings, updatedAt = new Date()) {
      const entries = Object.entries(strings);
      if (entries.length === 0) return [];

      const upserted: TranslationString[] = [];
      for (let i = 0; i < entries.length; i += UPSERT_CHUNK) {
        const chunk = entries.slice(i, i + UPSERT_CHUNK);
        const rows = await db
          .insert(translationStrings)
          .values(
            chunk.map(([stringKey, value]) => ({
              productId,
              stringKey,
              language,
              value,
              updatedAt,
            }))
          )
          .onConflictDoUpdate({
            target: [
              translationStrings.productId,
              translationStrings.stringKey,
              translationStrings.language,
            ],
            set: {
              value: sql`excluded.value`,
              updatedAt: sql`excluded.updated_at`,
            },
          })
          .returning();
        upserted.push(...rows.map(toEntity));
      }
      return upserted;
    },

    async findByLanguage(productId, language, keys) {
      if (keys && keys.length === 0) return [];
      const conditions = [
        eq(translationStrings.productId, productId),
        eq(translationStrings.language, language),
      ];
      if (keys) conditions.push(inArray(translationStrings.stringKey, keys));
      const rows = await db
        .select()
        .from(translationStrings)
        .where(and(...conditions));
      return rows.map(toEntity);
    },

    async listLanguages(productId) {
      const rows = await db
        .selectDistinct({ language: translationStrings.language })
        .from(translationStrings)
        .where(eq(translationStrings.productId, productId))
        .orderBy(translationStrings.language);
      return rows.map((row) => row.language);
    },

    async deleteKeys(productId, language, keys) {
      if (keys.length === 0) return 0;
      const rows = await db
        .delete(translationStrings)
        .where(
          and(
            eq(translationStrings.productId, productId),
            eq(translationStrings.language, language),
            inArray(translationStrings.stringKey, keys)
          )
        )
        .returning({ stringKey: translationStrings.stringKey });
      return rows.length;
    },
  };
}
