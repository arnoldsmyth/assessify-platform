import {
  ok,
  type CallerContext,
  type Client,
  type Organization,
  type RoleAssignment,
} from '@assessify/domain';
import type { ClientRepository, NewClient, OrganizationRepository } from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import { createClientService } from './client-service';

const ORG_ID = '01890000-0000-7000-8000-0000000000a1';
const OTHER_ORG_ID = '01890000-0000-7000-8000-0000000000a2';
const CLIENT_ID = '01890000-0000-7000-8000-00000000c001';
const NOW = new Date('2026-07-23T12:00:00Z');

function assignment(
  role: RoleAssignment['role'],
  scope: { organizationId?: string; clientId?: string } = {}
): RoleAssignment {
  return {
    role,
    organizationId: scope.organizationId ?? null,
    productId: null,
    clientId: scope.clientId ?? null,
    permissions: {
      products: [],
      groups: [],
      canPlaceOrders: false,
      canViewResults: false,
      canReleaseReports: false,
    },
  };
}

const superAdmin: CallerContext = {
  kind: 'user',
  id: '11111111-1111-7111-8111-111111111111',
  roles: [assignment('super_admin')],
};
const orgAdmin: CallerContext = {
  kind: 'user',
  id: '22222222-2222-7222-8222-222222222222',
  roles: [assignment('assessment_admin', { organizationId: ORG_ID })],
};
const otherOrgAdmin: CallerContext = {
  kind: 'user',
  id: '44444444-4444-7444-8444-444444444444',
  roles: [assignment('assessment_admin', { organizationId: OTHER_ORG_ID })],
};
const clientAdmin: CallerContext = {
  kind: 'user',
  id: '33333333-3333-7333-8333-333333333333',
  roles: [assignment('client_admin', { clientId: CLIENT_ID })],
};

function fixtureOrganization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: ORG_ID,
    name: 'PRO-D Publishing',
    slug: 'pro-d-publishing',
    status: 'active',
    connectedStripeAccountId: null,
    settlementEmail: null,
    settlementCurrency: 'EUR',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function fixtureClient(overrides: Partial<Client> = {}): Client {
  return {
    id: CLIENT_ID,
    organizationId: ORG_ID,
    clientNumber: 7,
    name: 'Acme Talent',
    billingEmail: null,
    billingAddress: null,
    defaultCurrency: 'EUR',
    xeroContactId: null,
    timezone: 'Europe/Dublin',
    notificationOverrides: null,
    source: 'native',
    legacyId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeOrgRepo(seed: Organization[] = [fixtureOrganization()]): OrganizationRepository {
  const rows = new Map(seed.map((o) => [o.id, o]));
  return {
    async findById(id) {
      return rows.get(id) ?? null;
    },
    findBySlug: vi.fn(),
    async findByIds(ids) {
      return [...rows.values()].filter((o) => ids.includes(o.id));
    },
    insert: vi.fn(),
    update: vi.fn(),
    async listAll() {
      return [...rows.values()];
    },
  };
}

function makeClientsRepo(seed: Client[] = [fixtureClient()]) {
  const rows = new Map(seed.map((c) => [c.id, c]));
  let nextNumber = Math.max(0, ...seed.map((c) => c.clientNumber)) + 1;
  const repo: ClientRepository = {
    async listAll() {
      return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async findByIds(ids) {
      return [...rows.values()].filter((c) => ids.includes(c.id));
    },
    async listByOrganizationIds(organizationIds) {
      return [...rows.values()].filter((c) => organizationIds.includes(c.organizationId));
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async insert(newClient: NewClient) {
      const client: Client = { ...newClient, clientNumber: nextNumber };
      nextNumber += 1;
      rows.set(client.id, client);
      return client;
    },
    async update(id, patch) {
      const existing = rows.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch } as Client;
      rows.set(id, updated);
      return updated;
    },
  };
  return { repo, rows };
}

function makeAudit(): AuditService {
  return {
    record: vi.fn(async (actor, action, entityRef, detail) =>
      ok({
        id: '01890000-0000-7000-8000-00000000aaaa',
        actor,
        action,
        entityRef,
        detail: detail ?? {},
        createdAt: NOW,
      })
    ),
    listByEntity: vi.fn(),
  } as unknown as AuditService;
}

function makeService(options: {
  organizations?: Organization[];
  clients?: Client[];
}) {
  const { repo: clients, rows } = makeClientsRepo(options.clients);
  const audit = makeAudit();
  const service = createClientService({
    clients,
    organizations: makeOrgRepo(options.organizations),
    audit,
    now: () => NOW,
    generateId: () => 'new-client-id',
  });
  return { service, audit, rows };
}

describe('clientService.create', () => {
  const validInput = { organizationId: ORG_ID, name: 'New Client' };

  it('allows super_admin to create a client in any organization', async () => {
    const { service, audit } = makeService({});
    const result = await service.create(superAdmin, validInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.organizationId).toBe(ORG_ID);
      expect(result.value.name).toBe('New Client');
      expect(result.value.defaultCurrency).toBe('EUR');
      expect(result.value.timezone).toBe('Europe/Dublin');
    }
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: superAdmin.id },
      'client.created',
      { type: 'client', id: 'new-client-id' },
      expect.objectContaining({ organizationId: ORG_ID })
    );
  });

  it('allows an org admin to create a client in their own organization', async () => {
    const { service } = makeService({});
    const result = await service.create(orgAdmin, validInput);
    expect(result.ok).toBe(true);
  });

  it('denies an org admin creating a client in another organization', async () => {
    const { service } = makeService({
      organizations: [fixtureOrganization(), fixtureOrganization({ id: OTHER_ORG_ID, slug: 'other' })],
    });
    const result = await service.create(otherOrgAdmin, validInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('client/forbidden');
  });

  it('denies client_admin from creating clients', async () => {
    const { service } = makeService({});
    const result = await service.create(clientAdmin, validInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('client/forbidden');
  });

  it('rejects an unknown organization', async () => {
    const { service } = makeService({});
    const result = await service.create(superAdmin, { organizationId: OTHER_ORG_ID, name: 'X' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('client/organization_not_found');
  });

  it('fails validation for a missing name', async () => {
    const { service } = makeService({});
    const result = await service.create(superAdmin, { organizationId: ORG_ID, name: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('client/validation');
  });

  it('generates sequential client numbers', async () => {
    const { service, rows } = makeService({
      clients: [fixtureClient({ id: 'existing', clientNumber: 41 })],
    });
    const result = await service.create(superAdmin, { organizationId: ORG_ID, name: 'Next Client' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.clientNumber).toBe(42);
    expect(rows.size).toBe(2);
  });
});

describe('clientService.update', () => {
  it('allows super_admin to update any client', async () => {
    const { service } = makeService({});
    const result = await service.update(superAdmin, CLIENT_ID, { name: 'Renamed' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('Renamed');
  });

  it('allows an org admin to update a client in their own organization', async () => {
    const { service } = makeService({});
    const result = await service.update(orgAdmin, CLIENT_ID, { name: 'Renamed' });
    expect(result.ok).toBe(true);
  });

  it('denies an org admin updating a client outside their organization', async () => {
    const { service } = makeService({});
    const result = await service.update(otherOrgAdmin, CLIENT_ID, { name: 'Renamed' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('client/forbidden');
  });

  it('denies client_admin from updating clients', async () => {
    const { service } = makeService({});
    const result = await service.update(clientAdmin, CLIENT_ID, { name: 'Renamed' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('client/forbidden');
  });

  it('returns not_found for an unknown client', async () => {
    const { service } = makeService({});
    const result = await service.update(superAdmin, OTHER_ORG_ID, { name: 'X' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('client/not_found');
  });

  it('fails validation for an invalid billing email', async () => {
    const { service } = makeService({});
    const result = await service.update(superAdmin, CLIENT_ID, { billingEmail: 'not-an-email' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('client/validation');
  });
});

describe('clientService.get', () => {
  it('allows super_admin and the org admin of the client', async () => {
    const { service } = makeService({});
    expect((await service.get(superAdmin, CLIENT_ID)).ok).toBe(true);
    expect((await service.get(orgAdmin, CLIENT_ID)).ok).toBe(true);
  });

  it('denies an org admin of another organization and client roles', async () => {
    const { service } = makeService({});
    const otherOrgResult = await service.get(otherOrgAdmin, CLIENT_ID);
    expect(otherOrgResult.ok).toBe(false);
    if (!otherOrgResult.ok) expect(otherOrgResult.error.code).toBe('client/forbidden');

    const clientAdminResult = await service.get(clientAdmin, CLIENT_ID);
    expect(clientAdminResult.ok).toBe(false);
    if (!clientAdminResult.ok) expect(clientAdminResult.error.code).toBe('client/forbidden');
  });
});

describe('clientService.list', () => {
  it('returns every client for super_admin', async () => {
    const { service } = makeService({
      clients: [fixtureClient(), fixtureClient({ id: 'c2', organizationId: OTHER_ORG_ID, name: 'Globex' })],
    });
    const result = await service.list(superAdmin);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });

  it('scopes org admins to their own organization', async () => {
    const { service } = makeService({
      clients: [fixtureClient(), fixtureClient({ id: 'c2', organizationId: OTHER_ORG_ID, name: 'Globex' })],
    });
    const result = await service.list(orgAdmin);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((c) => c.id)).toEqual([CLIENT_ID]);
  });

  it('denies client roles', async () => {
    const { service } = makeService({});
    const result = await service.list(clientAdmin);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('client/forbidden');
  });
});
