import { reportTemplateVersions, type Database } from '@assessify/db';
import type { ReportTemplateStatus } from '@assessify/domain';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

/**
 * Data access for `report_template_versions` (spec 04 catalogue; spec 09
 * re-scoped 2026-07-21: uploaded HTML templates). Rows map to the
 * ReportTemplateVersion entity; business rules (who may upload,
 * single-active-per-product, version numbering, config validation) live in
 * the report template service, not here
 * (docs/spec/appendix-architecture-layers.md §2).
 *
 * `config` is passed through as raw jsonb — the service validates it against
 * `reportTemplateConfigSchema` (`{ storageKey, capabilities }`) on both
 * sides of the boundary.
 */

export interface ReportTemplateVersion {
  id: string;
  productId: string;
  /** Monotonic per product (spec 09 versioning mirrors spec 07's). */
  version: number;
  /** `uploaded_html` for storage-backed templates (see domain sentinel). */
  componentKey: string;
  /** Validated by the service (`reportTemplateConfigSchema`). */
  config: Record<string, unknown>;
  status: ReportTemplateStatus;
  createdAt: Date;
}

export interface ReportTemplateVersionRepository {
  findById(id: string): Promise<ReportTemplateVersion | null>;
  /** The single active row for a product, if any. */
  findActive(productId: string): Promise<ReportTemplateVersion | null>;
  /** All versions for a product, newest version first. */
  listByProduct(productId: string): Promise<ReportTemplateVersion[]>;
  /** Highest version number for a product; 0 when none. */
  maxVersion(productId: string): Promise<number>;
  insert(version: ReportTemplateVersion): Promise<ReportTemplateVersion>;
  /** Returns the updated row, or null if no row matched. */
  updateStatus(id: string, status: ReportTemplateStatus): Promise<ReportTemplateVersion | null>;
}

type ReportTemplateVersionRow = typeof reportTemplateVersions.$inferSelect;

function toEntity(row: ReportTemplateVersionRow): ReportTemplateVersion {
  return {
    id: row.id,
    productId: row.productId,
    version: row.version,
    componentKey: row.componentKey,
    config: row.config as Record<string, unknown>,
    status: row.status as ReportTemplateStatus,
    createdAt: row.createdAt,
  };
}

export function createReportTemplateVersionRepository(
  db: Database
): ReportTemplateVersionRepository {
  return {
    async findById(id) {
      const rows = await db
        .select()
        .from(reportTemplateVersions)
        .where(eq(reportTemplateVersions.id, id))
        .limit(1);
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async findActive(productId) {
      const rows = await db
        .select()
        .from(reportTemplateVersions)
        .where(
          and(
            eq(reportTemplateVersions.productId, productId),
            eq(reportTemplateVersions.status, 'active')
          )
        )
        .limit(1);
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async listByProduct(productId) {
      const rows = await db
        .select()
        .from(reportTemplateVersions)
        .where(eq(reportTemplateVersions.productId, productId))
        .orderBy(desc(reportTemplateVersions.version), asc(reportTemplateVersions.id));
      return rows.map(toEntity);
    },

    async maxVersion(productId) {
      const rows = await db
        .select({ max: sql<number | null>`max(${reportTemplateVersions.version})::int` })
        .from(reportTemplateVersions)
        .where(eq(reportTemplateVersions.productId, productId));
      return rows[0]?.max ?? 0;
    },

    async insert(version) {
      const rows = await db
        .insert(reportTemplateVersions)
        .values({
          id: version.id,
          productId: version.productId,
          version: version.version,
          componentKey: version.componentKey,
          config: version.config,
          status: version.status,
          createdAt: version.createdAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Insert into report_template_versions returned no row');
      return toEntity(row);
    },

    async updateStatus(id, status) {
      const rows = await db
        .update(reportTemplateVersions)
        .set({ status })
        .where(eq(reportTemplateVersions.id, id))
        .returning();
      const row = rows[0];
      return row ? toEntity(row) : null;
    },
  };
}
