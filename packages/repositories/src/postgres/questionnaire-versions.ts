import { questionnaireVersions, type Database } from '@assessify/db';
import type { QuestionnaireDefinition } from '@assessify/questionnaire-schema';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

/**
 * Data access for `questionnaire_versions` (spec 04 catalogue, spec 07
 * versioning rules). Rows map to the QuestionnaireVersion entity; business
 * rules (who may import, single-active-per-product+variant, version
 * numbering) live in the questionnaire version service, not here
 * (docs/spec/appendix-architecture-layers.md §2).
 */

export type QuestionnaireVersionStatus = 'draft' | 'active' | 'retired';

export interface QuestionnaireVersion {
  id: string;
  productId: string;
  /** Monotonic per product; rater variants share the number (spec 07). */
  version: number;
  /** 'self' | rater variant key (e.g. 'manager', 'peer'). */
  variant: string;
  /** Validated against @assessify/questionnaire-schema before insert. */
  definition: QuestionnaireDefinition;
  status: QuestionnaireVersionStatus;
  /** Better Auth user id of the importer; null for system imports. */
  createdBy: string | null;
  createdAt: Date;
}

export interface QuestionnaireVersionRepository {
  findById(id: string): Promise<QuestionnaireVersion | null>;
  /** The single active row for a product+variant, if any. */
  findActive(productId: string, variant: string): Promise<QuestionnaireVersion | null>;
  /** All versions for a product, newest version first (variants A→Z within a version). */
  listByProduct(productId: string): Promise<QuestionnaireVersion[]>;
  /** Highest version number across all variants of a product; 0 when none. */
  maxVersion(productId: string): Promise<number>;
  insert(version: QuestionnaireVersion): Promise<QuestionnaireVersion>;
  /** Returns the updated row, or null if no row matched. */
  updateStatus(
    id: string,
    status: QuestionnaireVersionStatus
  ): Promise<QuestionnaireVersion | null>;
}

type QuestionnaireVersionRow = typeof questionnaireVersions.$inferSelect;

function toEntity(row: QuestionnaireVersionRow): QuestionnaireVersion {
  return {
    id: row.id,
    productId: row.productId,
    version: row.version,
    variant: row.variant,
    definition: row.definition as QuestionnaireDefinition,
    status: row.status as QuestionnaireVersionStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export function createQuestionnaireVersionRepository(
  db: Database
): QuestionnaireVersionRepository {
  return {
    async findById(id) {
      const rows = await db
        .select()
        .from(questionnaireVersions)
        .where(eq(questionnaireVersions.id, id))
        .limit(1);
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async findActive(productId, variant) {
      const rows = await db
        .select()
        .from(questionnaireVersions)
        .where(
          and(
            eq(questionnaireVersions.productId, productId),
            eq(questionnaireVersions.variant, variant),
            eq(questionnaireVersions.status, 'active')
          )
        )
        .limit(1);
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async listByProduct(productId) {
      const rows = await db
        .select()
        .from(questionnaireVersions)
        .where(eq(questionnaireVersions.productId, productId))
        .orderBy(desc(questionnaireVersions.version), asc(questionnaireVersions.variant));
      return rows.map(toEntity);
    },

    async maxVersion(productId) {
      const rows = await db
        .select({ max: sql<number | null>`max(${questionnaireVersions.version})::int` })
        .from(questionnaireVersions)
        .where(eq(questionnaireVersions.productId, productId));
      return rows[0]?.max ?? 0;
    },

    async insert(version) {
      const rows = await db
        .insert(questionnaireVersions)
        .values({
          id: version.id,
          productId: version.productId,
          version: version.version,
          variant: version.variant,
          definition: version.definition,
          status: version.status,
          createdBy: version.createdBy,
          createdAt: version.createdAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Insert into questionnaire_versions returned no row');
      return toEntity(row);
    },

    async updateStatus(id, status) {
      const rows = await db
        .update(questionnaireVersions)
        .set({ status })
        .where(eq(questionnaireVersions.id, id))
        .returning();
      const row = rows[0];
      return row ? toEntity(row) : null;
    },
  };
}
