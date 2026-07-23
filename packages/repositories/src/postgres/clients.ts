import { clients, type Database } from '@assessify/db';
import type { Client } from '@assessify/domain';
import { asc, eq, inArray, sql } from 'drizzle-orm';

/**
 * Data access for `clients` (spec 04 parties). The order wizard needs a
 * client picker (spec 06 wizard step 1: "Choose client (super admin)") and
 * the orders list resolves client names for display — those live as the
 * lightweight `ClientSummary` projections below. Full lifecycle management
 * (create/update, O1) works with the full `Client` entity instead.
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

/**
 * Insert payload (O1): the repository generates `clientNumber` from
 * `client_number_seq` inside the insert (spec 04 identifier conventions,
 * mirrors `order_ref_seq` in postgres/orders.ts) — it is never
 * client-supplied.
 */
export type NewClient = Omit<Client, 'clientNumber'>;

/** Fields updatable after creation; `updatedAt` is set by the service. `organizationId` and `clientNumber` are immutable via this path. */
export type ClientPatch = Partial<Omit<Client, 'id' | 'organizationId' | 'clientNumber' | 'createdAt'>>;

export interface ClientRepository {
  /** All clients, name A→Z. */
  listAll(): Promise<ClientSummary[]>;
  /** The named clients, name A→Z; unknown ids are simply absent. */
  findByIds(ids: string[]): Promise<ClientSummary[]>;
  /** All clients of the named organizations, name A→Z (org-admin scoping). */
  listByOrganizationIds(organizationIds: string[]): Promise<ClientSummary[]>;
  /** One client, full entity (management CRUD), or null. */
  findById(id: string): Promise<Client | null>;
  /** Generates `clientNumber` from `client_number_seq` inside the insert. */
  insert(client: NewClient): Promise<Client>;
  /** Returns the updated client, or null if no row matched. */
  update(id: string, patch: ClientPatch): Promise<Client | null>;
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

type FullClientRow = typeof clients.$inferSelect;

function toClientEntity(row: FullClientRow): Client {
  return {
    id: row.id,
    organizationId: row.organizationId,
    clientNumber: row.clientNumber,
    name: row.name,
    billingEmail: row.billingEmail,
    billingAddress: (row.billingAddress as Record<string, unknown> | null) ?? null,
    defaultCurrency: row.defaultCurrency,
    xeroContactId: row.xeroContactId,
    timezone: row.timezone,
    notificationOverrides: (row.notificationOverrides as Record<string, unknown> | null) ?? null,
    source: row.source,
    legacyId: row.legacyId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

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

    async findById(id) {
      const rows = await db.select().from(clients).where(eq(clients.id, id)).limit(1);
      const row = rows[0];
      return row ? toClientEntity(row) : null;
    },

    async insert(newClient) {
      const rows = await db
        .insert(clients)
        .values({
          id: newClient.id,
          organizationId: newClient.organizationId,
          // Generated inside the insert transaction, never client-side (spec
          // 04 identifier conventions — mirrors order_ref_seq in orders.ts).
          clientNumber: sql`nextval('client_number_seq')`,
          name: newClient.name,
          billingEmail: newClient.billingEmail,
          billingAddress: newClient.billingAddress,
          defaultCurrency: newClient.defaultCurrency,
          xeroContactId: newClient.xeroContactId,
          timezone: newClient.timezone,
          notificationOverrides: newClient.notificationOverrides,
          source: newClient.source,
          legacyId: newClient.legacyId,
          createdAt: newClient.createdAt,
          updatedAt: newClient.updatedAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('Insert into clients returned no row');
      return toClientEntity(row);
    },

    async update(id, patch) {
      if (Object.keys(patch).length === 0) return this.findById(id);
      const rows = await db.update(clients).set(patch).where(eq(clients.id, id)).returning();
      const row = rows[0];
      return row ? toClientEntity(row) : null;
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
