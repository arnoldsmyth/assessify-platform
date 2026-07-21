import { organizations, type Database } from '@assessify/db';
import type { Organization, OrganizationStatus } from '@assessify/domain';
import { asc, eq, inArray } from 'drizzle-orm';

/**
 * Data access for `organizations` (M1 — owner decisions 2026-07-21). Pure
 * persistence: rows map to domain entities, no business rules.
 */

/** Fields updatable after creation; `updatedAt` is set by the service. */
export type OrganizationPatch = Partial<Omit<Organization, 'id' | 'createdAt'>>;

export interface OrganizationRepository {
  findById(id: string): Promise<Organization | null>;
  findBySlug(slug: string): Promise<Organization | null>;
  /** The named organizations, name A→Z; unknown ids are simply absent. */
  findByIds(ids: string[]): Promise<Organization[]>;
  insert(organization: Organization): Promise<Organization>;
  /** Returns the updated organization, or null if no row matched. */
  update(id: string, patch: OrganizationPatch): Promise<Organization | null>;
  /** All organizations, name A→Z. */
  listAll(): Promise<Organization[]>;
}

type OrganizationRow = typeof organizations.$inferSelect;

function toEntity(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status as OrganizationStatus,
    connectedStripeAccountId: row.connectedStripeAccountId,
    settlementEmail: row.settlementEmail,
    settlementCurrency: row.settlementCurrency,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createOrganizationRepository(db: Database): OrganizationRepository {
  return {
    async findById(id) {
      const rows = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async findBySlug(slug) {
      const rows = await db
        .select()
        .from(organizations)
        .where(eq(organizations.slug, slug))
        .limit(1);
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async findByIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .select()
        .from(organizations)
        .where(inArray(organizations.id, ids))
        .orderBy(asc(organizations.name));
      return rows.map(toEntity);
    },

    async insert(organization) {
      const rows = await db.insert(organizations).values(organization).returning();
      const row = rows[0];
      if (!row) throw new Error('Insert into organizations returned no row');
      return toEntity(row);
    },

    async update(id, patch) {
      if (Object.keys(patch).length === 0) return this.findById(id);
      const rows = await db
        .update(organizations)
        .set(patch)
        .where(eq(organizations.id, id))
        .returning();
      const row = rows[0];
      return row ? toEntity(row) : null;
    },

    async listAll() {
      const rows = await db.select().from(organizations).orderBy(asc(organizations.name));
      return rows.map(toEntity);
    },
  };
}
