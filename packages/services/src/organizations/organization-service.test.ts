import {
  ok,
  type CallerContext,
  type ClientProductAccessGrant,
  type Organization,
  type Product,
  type ProductPrice,
  type RoleAssignment,
} from '@assessify/domain';
import type {
  ClientProductAccessRepository,
  ClientRepository,
  ClientSummary,
  OrganizationRepository,
  ProductPriceRepository,
  ProductRepository,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import { createOrganizationService } from './organization-service';

const ORG_ID = '01890000-0000-7000-8000-0000000000a1';
const OTHER_ORG_ID = '01890000-0000-7000-8000-0000000000a2';
const PRODUCT_ID = '01890000-0000-7000-8000-000000000001';
const CLIENT_ID = '01890000-0000-7000-8000-00000000c001';
const OTHER_ORG_CLIENT_ID = '01890000-0000-7000-8000-00000000c002';
const NOW = new Date('2026-07-21T12:00:00Z');

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

function fixtureProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    organizationId: ORG_ID,
    slug: 'pro-d',
    name: 'PRO-D',
    status: 'active',
    defaultAccess: true,
    branding: {},
    defaultLanguage: 'en',
    availableLanguages: ['en', 'es'],
    externalIds: {},
    scoringConfig: { mode: 'sync_internal', timeoutSeconds: 30, maxAttempts: 3 },
    notificationDefaults: {},
    reportPageSizeDefault: 'a4',
    retailEnabled: false,
    retailPrice: null,
    retailCurrency: null,
    revenueSplitPct: null,
    royaltyPolicy: null,
    timezone: 'Europe/Dublin',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function clientSummary(overrides: Partial<ClientSummary> = {}): ClientSummary {
  return {
    id: CLIENT_ID,
    organizationId: ORG_ID,
    clientNumber: 7,
    name: 'Acme Talent',
    defaultCurrency: 'EUR',
    ...overrides,
  };
}

function makeOrgRepo(seed: Organization[] = [fixtureOrganization()]) {
  const rows = new Map(seed.map((o) => [o.id, o]));
  const repo: OrganizationRepository = {
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async findBySlug(slug) {
      return [...rows.values()].find((o) => o.slug === slug) ?? null;
    },
    async findByIds(ids) {
      return [...rows.values()]
        .filter((o) => ids.includes(o.id))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async insert(organization) {
      rows.set(organization.id, organization);
      return organization;
    },
    async update(id, patch) {
      const existing = rows.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch } as Organization;
      rows.set(id, updated);
      return updated;
    },
    async listAll() {
      return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  };
  return { repo, rows };
}

function makeProductsRepo(seed: Product[] = [fixtureProduct()]) {
  const rows = new Map(seed.map((p) => [p.id, p]));
  return {
    repo: {
      async findById(id: string) {
        return rows.get(id) ?? null;
      },
      async update(id: string, patch: Partial<Product>) {
        const existing = rows.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...patch } as Product;
        rows.set(id, updated);
        return updated;
      },
      findBySlug: vi.fn(),
      insert: vi.fn(),
      list: vi.fn(),
    } as unknown as ProductRepository,
    rows,
  };
}

function makePricesRepo() {
  const rows = new Map<string, ProductPrice>();
  const key = (productId: string, language: string, currency: string) =>
    `${productId}:${language}:${currency}`;
  const repo: ProductPriceRepository = {
    async listByProduct(productId) {
      return [...rows.values()].filter((p) => p.productId === productId);
    },
    async upsert(row) {
      const k = key(row.productId, row.language, row.currency);
      const existing = rows.get(k);
      const price: ProductPrice = existing
        ? { ...existing, unitPrice: row.unitPrice, updatedAt: row.timestamp }
        : {
            id: row.id,
            productId: row.productId,
            language: row.language,
            currency: row.currency,
            unitPrice: row.unitPrice,
            createdAt: row.timestamp,
            updatedAt: row.timestamp,
          };
      rows.set(k, price);
      return price;
    },
    async delete(productId, language, currency) {
      return rows.delete(key(productId, language, currency));
    },
  };
  return { repo, rows };
}

function makeAccessRepo() {
  const rows = new Map<string, ClientProductAccessGrant>();
  const key = (clientId: string, productId: string) => `${clientId}:${productId}`;
  const repo: ClientProductAccessRepository = {
    async grant(clientId, productId, createdAt) {
      const k = key(clientId, productId);
      const existing = rows.get(k);
      if (existing) return existing;
      const grant = { clientId, productId, createdAt };
      rows.set(k, grant);
      return grant;
    },
    async revoke(clientId, productId) {
      return rows.delete(key(clientId, productId));
    },
    async listByProduct(productId) {
      return [...rows.values()].filter((g) => g.productId === productId);
    },
    async listByClient(clientId) {
      return [...rows.values()].filter((g) => g.clientId === clientId);
    },
  };
  return { repo, rows };
}

function makeClientsRepo(seed: ClientSummary[] = [clientSummary()]) {
  const repo: ClientRepository = {
    async listAll() {
      return seed;
    },
    async findByIds(ids) {
      return seed.filter((c) => ids.includes(c.id));
    },
    async listByOrganizationIds(organizationIds) {
      return seed.filter((c) => organizationIds.includes(c.organizationId));
    },
  };
  return repo;
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
  products?: Product[];
  clients?: ClientSummary[];
} = {}) {
  const orgs = makeOrgRepo(options.organizations);
  const products = makeProductsRepo(options.products);
  const prices = makePricesRepo();
  const access = makeAccessRepo();
  const audit = makeAudit();
  const service = createOrganizationService({
    organizations: orgs.repo,
    products: products.repo,
    productPrices: prices.repo,
    clientProductAccess: access.repo,
    clients: makeClientsRepo(options.clients),
    audit,
    now: () => NOW,
  });
  return { service, orgs, products, prices, access, audit };
}

describe('organizationService CRUD (super_admin only)', () => {
  it('creates an organization with defaults and audits it', async () => {
    const { service, audit } = makeService({ organizations: [] });

    const result = await service.create(superAdmin, {
      name: 'Insight Publishing',
      slug: 'insight-publishing',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('active');
    expect(result.value.settlementCurrency).toBe('EUR');
    expect(result.value.connectedStripeAccountId).toBeNull();
    expect(result.value.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: superAdmin.id },
      'organization.created',
      { type: 'organization', id: result.value.id },
      { slug: 'insight-publishing' }
    );
  });

  it('rejects duplicate slugs', async () => {
    const { service } = makeService();
    const result = await service.create(superAdmin, {
      name: 'Copycat',
      slug: 'pro-d-publishing',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('organization/slug_taken');
  });

  it('denies create/update/archive/list to non super admins (org admins included)', async () => {
    const { service } = makeService();
    for (const caller of [orgAdmin, clientAdmin]) {
      for (const result of [
        await service.create(caller, { name: 'X', slug: 'x-org' }),
        await service.update(caller, ORG_ID, { name: 'Y' }),
        await service.archive(caller, ORG_ID),
        await service.list(caller),
      ]) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('organization/forbidden');
      }
    }
  });

  it('updates fields and bumps updatedAt', async () => {
    const { service } = makeService();
    const result = await service.update(superAdmin, ORG_ID, {
      name: 'PRO-D Global',
      settlementEmail: 'finance@pro-d.example',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('PRO-D Global');
      expect(result.value.settlementEmail).toBe('finance@pro-d.example');
      expect(result.value.updatedAt).toEqual(NOW);
    }
  });

  it('archives idempotently', async () => {
    const { service } = makeService();
    const first = await service.archive(superAdmin, ORG_ID);
    expect(first.ok && first.value.status).toBe('archived');
    const again = await service.archive(superAdmin, ORG_ID);
    expect(again.ok && again.value.status).toBe('archived');
  });

  it('get is allowed for the org’s admin and denied for other orgs’ admins', async () => {
    const { service } = makeService();
    const own = await service.get(orgAdmin, ORG_ID);
    expect(own.ok).toBe(true);
    const other = await service.get(otherOrgAdmin, ORG_ID);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe('organization/forbidden');
  });
});

describe('organizationService.assignProductToOrg', () => {
  it('moves a product to another organization (super_admin) and audits it', async () => {
    const otherOrg = fixtureOrganization({
      id: OTHER_ORG_ID,
      slug: 'other-org',
      name: 'Other Org',
    });
    const { service, audit } = makeService({
      organizations: [fixtureOrganization(), otherOrg],
    });

    const result = await service.assignProductToOrg(superAdmin, PRODUCT_ID, OTHER_ORG_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.organizationId).toBe(OTHER_ORG_ID);
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: superAdmin.id },
      'product.assigned_to_organization',
      { type: 'product', id: PRODUCT_ID },
      { fromOrganizationId: ORG_ID, toOrganizationId: OTHER_ORG_ID }
    );
  });

  it('is idempotent for the current organization and denied to org admins', async () => {
    const { service, audit } = makeService();
    const same = await service.assignProductToOrg(superAdmin, PRODUCT_ID, ORG_ID);
    expect(same.ok).toBe(true);
    expect(audit.record).not.toHaveBeenCalled();

    const denied = await service.assignProductToOrg(orgAdmin, PRODUCT_ID, ORG_ID);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('organization/forbidden');
  });
});

describe('organizationService price list', () => {
  it('lets the org admin upsert a price per (language, currency) in minor units', async () => {
    const { service } = makeService();

    const created = await service.upsertPrice(orgAdmin, {
      productId: PRODUCT_ID,
      language: 'es',
      currency: 'EUR',
      unitPrice: 12500,
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.unitPrice).toBe(12500);

    // Overwrite in place — same key, new price.
    const overwritten = await service.upsertPrice(superAdmin, {
      productId: PRODUCT_ID,
      language: 'es',
      currency: 'EUR',
      unitPrice: 13000,
    });
    expect(overwritten.ok).toBe(true);
    if (overwritten.ok && created.ok) {
      expect(overwritten.value.id).toBe(created.value.id);
      expect(overwritten.value.unitPrice).toBe(13000);
    }

    const listed = await service.listPrices(orgAdmin, PRODUCT_ID);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toHaveLength(1);
  });

  it('rejects non-integer minor units and undeclared languages', async () => {
    const { service } = makeService();

    const fractional = await service.upsertPrice(orgAdmin, {
      productId: PRODUCT_ID,
      language: 'en',
      currency: 'EUR',
      unitPrice: 125.5,
    });
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fractional.error.code).toBe('organization/validation');

    // 'de' is not in the product's availableLanguages (['en', 'es']).
    const undeclared = await service.upsertPrice(orgAdmin, {
      productId: PRODUCT_ID,
      language: 'de',
      currency: 'EUR',
      unitPrice: 12500,
    });
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) {
      expect(undeclared.error.code).toBe('organization/language_not_available');
    }
  });

  it('denies admins of other organizations', async () => {
    const { service } = makeService();
    const denied = await service.upsertPrice(otherOrgAdmin, {
      productId: PRODUCT_ID,
      language: 'en',
      currency: 'EUR',
      unitPrice: 12500,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('organization/forbidden');
  });

  it('removes prices idempotently', async () => {
    const { service } = makeService();
    await service.upsertPrice(orgAdmin, {
      productId: PRODUCT_ID,
      language: 'en',
      currency: 'EUR',
      unitPrice: 9900,
    });
    const removed = await service.removePrice(orgAdmin, {
      productId: PRODUCT_ID,
      language: 'en',
      currency: 'EUR',
    });
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.value.removed).toBe(true);

    const again = await service.removePrice(orgAdmin, {
      productId: PRODUCT_ID,
      language: 'en',
      currency: 'EUR',
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.removed).toBe(false);
  });
});

describe('organizationService client product access', () => {
  it('grants and revokes access for a client of the product’s org', async () => {
    const { service } = makeService();

    const granted = await service.grantClientProductAccess(orgAdmin, {
      clientId: CLIENT_ID,
      productId: PRODUCT_ID,
    });
    expect(granted.ok).toBe(true);
    if (granted.ok) expect(granted.value.clientId).toBe(CLIENT_ID);

    // Idempotent: granting again keeps the original grant.
    const again = await service.grantClientProductAccess(orgAdmin, {
      clientId: CLIENT_ID,
      productId: PRODUCT_ID,
    });
    expect(again.ok).toBe(true);
    if (again.ok && granted.ok) expect(again.value.createdAt).toEqual(granted.value.createdAt);

    const listed = await service.listClientProductAccess(orgAdmin, PRODUCT_ID);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toHaveLength(1);

    const revoked = await service.revokeClientProductAccess(orgAdmin, {
      clientId: CLIENT_ID,
      productId: PRODUCT_ID,
    });
    expect(revoked.ok).toBe(true);
    if (revoked.ok) expect(revoked.value.revoked).toBe(true);
  });

  it('rejects grants for clients of a different organization', async () => {
    const { service } = makeService({
      clients: [
        clientSummary(),
        clientSummary({
          id: OTHER_ORG_CLIENT_ID,
          organizationId: OTHER_ORG_ID,
          name: 'Globex',
        }),
      ],
    });

    const result = await service.grantClientProductAccess(superAdmin, {
      clientId: OTHER_ORG_CLIENT_ID,
      productId: PRODUCT_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('organization/client_outside_organization');
    }
  });

  it('denies client admins and admins of other orgs', async () => {
    const { service } = makeService();
    for (const caller of [clientAdmin, otherOrgAdmin]) {
      const result = await service.grantClientProductAccess(caller, {
        clientId: CLIENT_ID,
        productId: PRODUCT_ID,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('organization/forbidden');
    }
  });
});

describe('organizationService.listOrgClients', () => {
  it('returns the org’s clients to its admin and to super_admin', async () => {
    const { service } = makeService({
      clients: [
        clientSummary(),
        clientSummary({
          id: OTHER_ORG_CLIENT_ID,
          organizationId: OTHER_ORG_ID,
          name: 'Globex',
        }),
      ],
    });
    for (const caller of [orgAdmin, superAdmin]) {
      const result = await service.listOrgClients(caller, ORG_ID);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.map((c) => c.id)).toEqual([CLIENT_ID]);
    }
  });

  it('denies admins of other organizations', async () => {
    const { service } = makeService();
    const result = await service.listOrgClients(otherOrgAdmin, ORG_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('organization/forbidden');
  });
});

describe('organizationService.listContexts', () => {
  it('derives platform, organization and client contexts from role assignments', async () => {
    const { service } = makeService();
    const caller: CallerContext = {
      kind: 'user',
      id: '99999999-9999-7999-8999-999999999999',
      roles: [
        assignment('super_admin'),
        assignment('assessment_admin', { organizationId: ORG_ID }),
        assignment('client_admin', { clientId: CLIENT_ID }),
      ],
    };

    const result = await service.listContexts(caller);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { kind: 'platform' },
      { kind: 'organization', id: ORG_ID, name: 'PRO-D Publishing' },
      { kind: 'client', id: CLIENT_ID, name: 'Acme Talent', organizationId: ORG_ID },
    ]);
  });

  it('returns only the caller’s own scopes', async () => {
    const { service } = makeService();
    const result = await service.listContexts(orgAdmin);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { kind: 'organization', id: ORG_ID, name: 'PRO-D Publishing' },
      ]);
    }
  });

  it('returns an empty list for non-user callers', async () => {
    const { service } = makeService();
    const result = await service.listContexts({ kind: 'system', id: 'system', roles: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});
