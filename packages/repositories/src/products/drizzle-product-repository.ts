import { products, type Database } from '@assessify/db';
import type {
  BrandingConfig,
  Product,
  ProductStatus,
  ReportPageSize,
  ScoringConfig,
} from '@assessify/domain';
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';

import type {
  ProductListQuery,
  ProductPage,
  ProductPatch,
  ProductRepository,
} from './product-repository';

type ProductRow = typeof products.$inferSelect;
type ProductInsertRow = typeof products.$inferInsert;

function toEntity(row: ProductRow): Product {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as ProductStatus,
    branding: (row.branding ?? {}) as BrandingConfig,
    defaultLanguage: row.defaultLanguage,
    availableLanguages: row.availableLanguages,
    externalIds: (row.externalIds ?? {}) as Record<string, string>,
    scoringConfig: row.scoringConfig as ScoringConfig,
    notificationDefaults: (row.notificationDefaults ?? {}) as Record<string, unknown>,
    reportPageSizeDefault: row.reportPageSizeDefault as ReportPageSize,
    retailEnabled: row.retailEnabled,
    retailPrice: row.retailPrice,
    retailCurrency: row.retailCurrency,
    connectedStripeAccountId: row.connectedStripeAccountId,
    revenueSplitPct: row.revenueSplitPct === null ? null : Number(row.revenueSplitPct),
    royaltyPolicy:
      row.royaltyPolicy === null || row.royaltyPolicy === undefined
        ? null
        : (row.royaltyPolicy as Record<string, unknown>),
    timezone: row.timezone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toInsertRow(product: Product): ProductInsertRow {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    status: product.status,
    branding: product.branding,
    defaultLanguage: product.defaultLanguage,
    availableLanguages: product.availableLanguages,
    externalIds: product.externalIds,
    scoringConfig: product.scoringConfig,
    notificationDefaults: product.notificationDefaults,
    reportPageSizeDefault: product.reportPageSizeDefault,
    retailEnabled: product.retailEnabled,
    retailPrice: product.retailPrice,
    retailCurrency: product.retailCurrency,
    connectedStripeAccountId: product.connectedStripeAccountId,
    revenueSplitPct: product.revenueSplitPct === null ? null : product.revenueSplitPct.toFixed(2),
    royaltyPolicy: product.royaltyPolicy,
    timezone: product.timezone,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

function toPatchRow(patch: ProductPatch): Partial<ProductInsertRow> {
  const row: Partial<ProductInsertRow> = {};
  if (patch.slug !== undefined) row.slug = patch.slug;
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.branding !== undefined) row.branding = patch.branding;
  if (patch.defaultLanguage !== undefined) row.defaultLanguage = patch.defaultLanguage;
  if (patch.availableLanguages !== undefined) row.availableLanguages = patch.availableLanguages;
  if (patch.externalIds !== undefined) row.externalIds = patch.externalIds;
  if (patch.scoringConfig !== undefined) row.scoringConfig = patch.scoringConfig;
  if (patch.notificationDefaults !== undefined)
    row.notificationDefaults = patch.notificationDefaults;
  if (patch.reportPageSizeDefault !== undefined)
    row.reportPageSizeDefault = patch.reportPageSizeDefault;
  if (patch.retailEnabled !== undefined) row.retailEnabled = patch.retailEnabled;
  if (patch.retailPrice !== undefined) row.retailPrice = patch.retailPrice;
  if (patch.retailCurrency !== undefined) row.retailCurrency = patch.retailCurrency;
  if (patch.connectedStripeAccountId !== undefined)
    row.connectedStripeAccountId = patch.connectedStripeAccountId;
  if (patch.revenueSplitPct !== undefined)
    row.revenueSplitPct = patch.revenueSplitPct === null ? null : patch.revenueSplitPct.toFixed(2);
  if (patch.royaltyPolicy !== undefined) row.royaltyPolicy = patch.royaltyPolicy;
  if (patch.timezone !== undefined) row.timezone = patch.timezone;
  if (patch.updatedAt !== undefined) row.updatedAt = patch.updatedAt;
  return row;
}

/** Escape LIKE wildcards so a user search term is matched literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export class DrizzleProductRepository implements ProductRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Product | null> {
    const rows = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
    const row = rows[0];
    return row ? toEntity(row) : null;
  }

  async findBySlug(slug: string): Promise<Product | null> {
    const rows = await this.db.select().from(products).where(eq(products.slug, slug)).limit(1);
    const row = rows[0];
    return row ? toEntity(row) : null;
  }

  async insert(product: Product): Promise<Product> {
    const rows = await this.db.insert(products).values(toInsertRow(product)).returning();
    const row = rows[0];
    if (!row) throw new Error('Insert into products returned no row');
    return toEntity(row);
  }

  async update(id: string, patch: ProductPatch): Promise<Product | null> {
    const row = toPatchRow(patch);
    if (Object.keys(row).length === 0) return this.findById(id);
    const rows = await this.db
      .update(products)
      .set(row)
      .where(eq(products.id, id))
      .returning();
    const updated = rows[0];
    return updated ? toEntity(updated) : null;
  }

  async list(query: ProductListQuery): Promise<ProductPage> {
    const conditions: SQL[] = [];
    if (query.status) conditions.push(eq(products.status, query.status));
    if (query.search) {
      const pattern = `%${escapeLike(query.search)}%`;
      const searchCondition = or(ilike(products.name, pattern), ilike(products.slug, pattern));
      if (searchCondition) conditions.push(searchCondition);
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countRows] = await Promise.all([
      this.db
        .select()
        .from(products)
        .where(where)
        .orderBy(desc(products.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(products).where(where),
    ]);

    return { items: rows.map(toEntity), total: countRows[0]?.count ?? 0 };
  }
}
