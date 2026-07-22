import { clients, type Database } from '@assessify/db';
import { asc, eq, inArray } from 'drizzle-orm';

/**
 * Read-only data access for `clients` (spec 04 parties). The order wizard
 * needs a client picker (spec 06 wizard step 1: "Choose client (super
 * admin)") and the orders list resolves client names for display. Client
 * lifecycle management (create/update) lands with its own epic — only the
 * projections the ordering surfaces need live here.
 */

export interface ClientSummary {
  id: string;
  /** Owning organization (M1 — clients belong to an org). */
  organizationId: string;
  /** From client_number_seq; used in INV references (display only). */
  clientNumber: number;
  name: string;
  defaultCurrency: string;
}

/**
 * The client projection completion notifications need (E6 — spec 13):
 * the policy-override jsonb plus the client's contact address. The billing
 * email doubles as the client-admin contact until a dedicated contact column
 * exists. PII: `billingEmail` must never appear in logs or audit detail.
 */
export interface ClientNotificationProfile {
  id: string;
  name: string;
  billingEmail: string | null;
  /** `clients.notification_overrides` jsonb — spec 13 precedence layer 2. */
  notificationOverrides: Record<string, unknown> | null;
}

/**
 * Deliberately separate from {@link ClientRepository} (whose picker/display
 * projections omit contact PII): completion notification dispatch is the one
 * flow that needs the override jsonb together with the contact address.
 */
export interface ClientNotificationRepository {
  /** One client's notification profile (overrides + contact), or null. */
  findNotificationProfile(id: string): Promise<ClientNotificationProfile | null>;
}

export interface ClientRepository {
  /** All clients, name A→Z. */
  listAll(): Promise<ClientSummary[]>;
  /** The named clients, name A→Z; unknown ids are simply absent. */
  findByIds(ids: string[]): Promise<ClientSummary[]>;
  /** All clients of the named organizations, name A→Z (org-admin scoping). */
  listByOrganizationIds(organizationIds: string[]): Promise<ClientSummary[]>;
}

type ClientRow = Pick<
  typeof clients.$inferSelect,
  'id' | 'organizationId' | 'clientNumber' | 'name' | 'defaultCurrency'
>;

function toSummary(row: ClientRow): ClientSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    clientNumber: row.clientNumber,
    name: row.name,
    defaultCurrency: row.defaultCurrency,
  };
}

const summaryColumns = {
  id: clients.id,
  organizationId: clients.organizationId,
  clientNumber: clients.clientNumber,
  name: clients.name,
  defaultCurrency: clients.defaultCurrency,
};

export function createClientRepository(db: Database): ClientRepository {
  return {
    async listAll() {
      const rows = await db.select(summaryColumns).from(clients).orderBy(asc(clients.name));
      return rows.map(toSummary);
    },

    async findByIds(ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .select(summaryColumns)
        .from(clients)
        .where(inArray(clients.id, ids))
        .orderBy(asc(clients.name));
      return rows.map(toSummary);
    },

    async listByOrganizationIds(organizationIds) {
      if (organizationIds.length === 0) return [];
      const rows = await db
        .select(summaryColumns)
        .from(clients)
        .where(inArray(clients.organizationId, organizationIds))
        .orderBy(asc(clients.name));
      return rows.map(toSummary);
    },
  };
}

export function createClientNotificationRepository(db: Database): ClientNotificationRepository {
  return {
    async findNotificationProfile(id) {
      const rows = await db
        .select({
          id: clients.id,
          name: clients.name,
          billingEmail: clients.billingEmail,
          notificationOverrides: clients.notificationOverrides,
        })
        .from(clients)
        .where(eq(clients.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        billingEmail: row.billingEmail,
        notificationOverrides:
          (row.notificationOverrides as Record<string, unknown> | null) ?? null,
      };
    },
  };
}
