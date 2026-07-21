import { clientProductAccess, type Database } from '@assessify/db';
import type { ClientProductAccessGrant } from '@assessify/domain';
import { and, asc, eq } from 'drizzle-orm';

/**
 * Data access for `client_product_access` — explicit per-client grants for
 * restricted products (`products.default_access = false`). Org-default
 * products need no rows here (M1/M2, owner decisions 2026-07-21).
 */

export interface ClientProductAccessRepository {
  /** Idempotent: granting twice keeps the original grant. */
  grant(clientId: string, productId: string, createdAt: Date): Promise<ClientProductAccessGrant>;
  /** Returns true when a grant was removed. */
  revoke(clientId: string, productId: string): Promise<boolean>;
  /** Grants for one product, oldest first. */
  listByProduct(productId: string): Promise<ClientProductAccessGrant[]>;
  /** Grants held by one client, oldest first. */
  listByClient(clientId: string): Promise<ClientProductAccessGrant[]>;
}

type GrantRow = typeof clientProductAccess.$inferSelect;

function toEntity(row: GrantRow): ClientProductAccessGrant {
  return { clientId: row.clientId, productId: row.productId, createdAt: row.createdAt };
}

export function createClientProductAccessRepository(
  db: Database
): ClientProductAccessRepository {
  return {
    async grant(clientId, productId, createdAt) {
      const rows = await db
        .insert(clientProductAccess)
        .values({ clientId, productId, createdAt })
        .onConflictDoNothing()
        .returning();
      const row = rows[0];
      if (row) return toEntity(row);
      // Conflict path: the grant already exists — return the existing row.
      const existing = await db
        .select()
        .from(clientProductAccess)
        .where(
          and(
            eq(clientProductAccess.clientId, clientId),
            eq(clientProductAccess.productId, productId)
          )
        )
        .limit(1);
      const found = existing[0];
      if (!found) throw new Error('client_product_access grant vanished during upsert');
      return toEntity(found);
    },

    async revoke(clientId, productId) {
      const rows = await db
        .delete(clientProductAccess)
        .where(
          and(
            eq(clientProductAccess.clientId, clientId),
            eq(clientProductAccess.productId, productId)
          )
        )
        .returning({ clientId: clientProductAccess.clientId });
      return rows.length > 0;
    },

    async listByProduct(productId) {
      const rows = await db
        .select()
        .from(clientProductAccess)
        .where(eq(clientProductAccess.productId, productId))
        .orderBy(asc(clientProductAccess.createdAt));
      return rows.map(toEntity);
    },

    async listByClient(clientId) {
      const rows = await db
        .select()
        .from(clientProductAccess)
        .where(eq(clientProductAccess.clientId, clientId))
        .orderBy(asc(clientProductAccess.createdAt));
      return rows.map(toEntity);
    },
  };
}
