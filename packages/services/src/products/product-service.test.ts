import {
  ok,
  type CallerContext,
  type Organization,
  type Product,
  type RoleAssignment,
} from '@assessify/domain';
import type {
  ClientProductAccessRepository,
  ClientRepository,
  ClientSummary,
  OrganizationRepository,
  ProductListQuery,
  ProductPatch,
  ProductPriceRepository,
  ProductRepository,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import { createProductService } from './product-service';

const ORG_ID = '01890000-0000-7000-8000-0000000000a1';
const OTHER_ORG_ID = '01890000-0000-7000-8000-0000000000a2';
const CLIENT_ID = '33333333-3333-7333-8333-333333333333';
const OTHER_ORG_CLIENT_ID = '44444444-4444-7444-8444-444444444444';

function assignment(role: RoleAssignment['role'], clientId: string | null = null): RoleAssignment {
  return {
    role,
    organizationId: null,
    productId: null,
    clientId,
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
const clientAdmin: CallerContext = {
  kind: 'user',
  id: '22222222-2222-7222-8222-222222222222',
  roles: [assignment('client_admin', '33333333-3333-7333-8333-333333333333')],
};

function fixtureProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG_ID,
    slug: 'pro-d',
    name: 'PRO-D',
    status: 'active',
    defaultAccess: true,
    branding: {},
    defaultLanguage: 'en',
    availableLanguages: ['en'],
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

/** In-memory fake implementing the repository port. */
function makeRepo(seed: Product[] = []) {
  const rows = new Map<string, Product>(seed.map((p) => [p.id, p]));
  const repo: ProductRepository = {
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async findBySlug(slug) {
      return [...rows.values()].find((p) => p.slug === slug) ?? null;
    },
    async insert(product) {
      rows.set(product.id, product);
      return product;
    },
    async update(id, patch: ProductPatch) {
      const existing = rows.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch } as Product;
      rows.set(id, updated);
      return updated;
    },
    async list(query: ProductListQuery) {
      let items = [...rows.values()];
      if (query.status) items = items.filter((p) => p.status === query.status);
      if (query.search) {
        const term = query.search.toLowerCase();
        items = items.filter(
          (p) => p.name.toLowerCase().includes(term) || p.slug.includes(term)
        );
      }
      return { items: items.slice(query.offset, query.offset + query.limit), total: items.length };
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
        createdAt: new Date('2026-07-14T12:00:00Z'),
      })
    ),
    listByEntity: vi.fn(),
  } as unknown as AuditService;
}

function makeOrganizationsRepo(): OrganizationRepository {
  const organization: Organization = {
    id: ORG_ID,
    name: 'PRO-D Publishing',
    slug: 'pro-d-publishing',
    status: 'active',
    connectedStripeAccountId: null,
    settlementEmail: null,
    settlementCurrency: 'EUR',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
  return {
    async findById(id) {
      return id === ORG_ID ? organization : null;
    },
    async findBySlug() {
      return null;
    },
    async findByIds(ids) {
      return ids.includes(ORG_ID) ? [organization] : [];
    },
    async insert(value) {
      return value;
    },
    async update() {
      return null;
    },
    async listAll() {
      return [organization];
    },
  };
}

/** Client directory double: CLIENT_ID lives in ORG_ID, the other elsewhere. */
function makeClientsRepo(): ClientRepository {
  const summaries: ClientSummary[] = [
    { id: CLIENT_ID, organizationId: ORG_ID, clientNumber: 1, name: 'Acme', defaultCurrency: 'EUR' },
    {
      id: OTHER_ORG_CLIENT_ID,
      organizationId: OTHER_ORG_ID,
      clientNumber: 2,
      name: 'Umbrella',
      defaultCurrency: 'EUR',
    },
  ];
  return {
    async listAll() {
      return summaries;
    },
    async findByIds(ids) {
      return summaries.filter((client) => ids.includes(client.id));
    },
    async listByOrganizationIds(organizationIds) {
      return summaries.filter((client) => organizationIds.includes(client.organizationId));
    },
    // Not exercised here — O1's client management flows have their own
    // client-service.test.ts.
    async findById() {
      return null;
    },
    insert: vi.fn(),
    update: vi.fn(),
  };
}

function makeAccessRepo(
  grants: { clientId: string; productId: string }[] = []
): ClientProductAccessRepository {
  return {
    grant: vi.fn(),
    revoke: vi.fn(),
    listByProduct: vi.fn(),
    async listByClient(clientId: string) {
      return grants
        .filter((grant) => grant.clientId === clientId)
        .map((grant) => ({ ...grant, createdAt: new Date('2026-07-01T00:00:00Z') }));
    },
  } as unknown as ClientProductAccessRepository;
}

function makePricesRepo(
  rows: { productId: string; language: string; currency: string; unitPrice: number }[] = []
): ProductPriceRepository {
  return {
    async listByProduct(productId: string) {
      return rows
        .filter((row) => row.productId === productId)
        .map((row, index) => ({
          id: `price-${index}`,
          ...row,
          createdAt: new Date('2026-07-01T00:00:00Z'),
          updatedAt: new Date('2026-07-01T00:00:00Z'),
        }));
    },
    upsert: vi.fn(),
    delete: vi.fn(),
  } as unknown as ProductPriceRepository;
}

interface ServiceOptions {
  grants?: { clientId: string; productId: string }[];
  prices?: { productId: string; language: string; currency: string; unitPrice: number }[];
}

function makeService(seed: Product[] = [], options: ServiceOptions = {}) {
  const { repo, rows } = makeRepo(seed);
  const audit = makeAudit();
  const service = createProductService({
    products: repo,
    organizations: makeOrganizationsRepo(),
    clients: makeClientsRepo(),
    clientProductAccess: makeAccessRepo(options.grants),
    productPrices: makePricesRepo(options.prices),
    audit,
    now: () => new Date('2026-07-14T12:00:00Z'),
  });
  return { service, rows, audit };
}

describe('productService.create', () => {
  it('creates a product with defaults applied (happy path)', async () => {
    const { service, rows, audit } = makeService();

    const result = await service.create(superAdmin, {
      organizationId: ORG_ID,
      slug: 'insight-360',
      name: 'Insight 360',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const product = result.value;
    expect(product.slug).toBe('insight-360');
    expect(product.status).toBe('active');
    expect(product.branding).toEqual({});
    expect(product.defaultLanguage).toBe('en');
    expect(product.availableLanguages).toEqual(['en']);
    expect(product.scoringConfig).toEqual({
      mode: 'sync_internal',
      timeoutSeconds: 30,
      maxAttempts: 3,
    });
    expect(product.reportPageSizeDefault).toBe('a4');
    expect(product.timezone).toBe('Europe/Dublin');
    expect(product.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(product.createdAt).toEqual(new Date('2026-07-14T12:00:00Z'));
    expect(rows.get(product.id)).toEqual(product);
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: superAdmin.id },
      'product.created',
      { type: 'product', id: product.id },
      { slug: 'insight-360' }
    );
  });

  it('accepts a full branding config', async () => {
    const { service } = makeService();

    const result = await service.create(superAdmin, {
      organizationId: ORG_ID,
      slug: 'insight-360',
      name: 'Insight 360',
      branding: {
        logoUrl: 'https://cdn.example.com/logo.svg',
        colors: { primary: '#0F766E', ink: '#1c1917' },
        fontFamily: "'Alte Haas', Georgia, serif",
        emailFrom: { name: 'Insight team', address: 'reports@example.com' },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.branding.colors?.primary).toBe('#0F766E');
    }
  });

  it('rejects an unknown organization', async () => {
    const { service } = makeService();

    const result = await service.create(superAdmin, {
      organizationId: '01890000-0000-7000-8000-00000000dead',
      slug: 'insight-360',
      name: 'Insight 360',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('product/organization_not_found');
  });

  it('rejects a duplicate slug', async () => {
    const { service } = makeService([fixtureProduct()]);

    const result = await service.create(superAdmin, { organizationId: ORG_ID, slug: 'pro-d', name: 'Copycat' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('product/slug_taken');
    }
  });

  it('rejects invalid branding (bad colour, bad logo URL)', async () => {
    const { service } = makeService();

    const result = await service.create(superAdmin, {
      organizationId: ORG_ID,
      slug: 'insight-360',
      name: 'Insight 360',
      branding: {
        logoUrl: 'javascript:alert(1)',
        colors: { primary: 'tomato' },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('product/validation');
      const issues = result.error.detail?.issues as { path: string; message: string }[];
      const paths = issues.map((issue) => issue.path);
      expect(paths).toContain('branding.colors.primary');
      expect(paths).toContain('branding.logoUrl');
    }
  });

  it('rejects reserved and malformed slugs (subdomain rules)', async () => {
    const { service } = makeService();

    for (const slug of ['app', 'www', 'Bad-Slug', '-leading', 'trailing-', 'a']) {
      const result = await service.create(superAdmin, { organizationId: ORG_ID, slug, name: 'X' });
      expect(result.ok, `slug "${slug}" should be rejected`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('product/validation');
    }
  });

  it('enforces retail and language invariants', async () => {
    const { service } = makeService();

    const retail = await service.create(superAdmin, {
      organizationId: ORG_ID,
      slug: 'insight-360',
      name: 'Insight 360',
      retailEnabled: true,
    });
    expect(retail.ok).toBe(false);
    if (!retail.ok) {
      const issues = retail.error.detail?.issues as { path: string }[];
      expect(issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(['retailPrice', 'retailCurrency'])
      );
    }

    const language = await service.create(superAdmin, {
      organizationId: ORG_ID,
      slug: 'insight-360',
      name: 'Insight 360',
      defaultLanguage: 'fr',
      availableLanguages: ['en'],
    });
    expect(language.ok).toBe(false);
  });

  it('is forbidden for non super admins', async () => {
    const { service } = makeService();

    const result = await service.create(clientAdmin, { slug: 'insight-360', name: 'Insight' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('product/forbidden');
  });
});

describe('productService.update', () => {
  it('updates fields and bumps updatedAt', async () => {
    const existing = fixtureProduct();
    const { service } = makeService([existing]);

    const result = await service.update(superAdmin, existing.id, {
      name: 'PRO-D (2026)',
      branding: { colors: { primary: '#C2410C' } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('PRO-D (2026)');
      expect(result.value.branding.colors?.primary).toBe('#C2410C');
      expect(result.value.updatedAt).toEqual(new Date('2026-07-14T12:00:00Z'));
      expect(result.value.slug).toBe('pro-d');
    }
  });

  it('rejects a slug change that collides with another product', async () => {
    const other = fixtureProduct({ id: '01890000-0000-7000-8000-000000000002', slug: 'other' });
    const existing = fixtureProduct();
    const { service } = makeService([existing, other]);

    const result = await service.update(superAdmin, existing.id, { slug: 'other' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('product/slug_taken');
  });

  it('validates invariants against the merged product', async () => {
    const existing = fixtureProduct({ availableLanguages: ['en', 'fr'], defaultLanguage: 'fr' });
    const { service } = makeService([existing]);

    // Dropping fr from availableLanguages would orphan the default language.
    const result = await service.update(superAdmin, existing.id, {
      availableLanguages: ['en'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('product/validation');
  });

  it('returns not_found for unknown or malformed ids', async () => {
    const { service } = makeService();

    const unknown = await service.update(superAdmin, '01890000-0000-7000-8000-00000000ffff', {});
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('product/not_found');

    const malformed = await service.update(superAdmin, 'not-a-uuid', {});
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('product/not_found');
  });
});

describe('productService.archive', () => {
  it('retires an active product and is idempotent', async () => {
    const existing = fixtureProduct();
    const { service } = makeService([existing]);

    const archived = await service.archive(superAdmin, existing.id);
    expect(archived.ok).toBe(true);
    if (archived.ok) expect(archived.value.status).toBe('retired');

    const again = await service.archive(superAdmin, existing.id);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.status).toBe('retired');
  });
});

describe('productService.list / get', () => {
  it('lists with paging metadata and filters', async () => {
    const a = fixtureProduct();
    const b = fixtureProduct({
      id: '01890000-0000-7000-8000-000000000002',
      slug: 'insight-360',
      name: 'Insight 360',
      status: 'retired',
    });
    const { service } = makeService([a, b]);

    const all = await service.list(superAdmin, {});
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.value.total).toBe(2);
      expect(all.value.page).toBe(1);
      expect(all.value.pageSize).toBe(20);
    }

    const active = await service.list(superAdmin, { status: 'active' });
    expect(active.ok && active.value.total).toBe(1);

    const searched = await service.list(superAdmin, { search: 'insight' });
    expect(searched.ok && searched.value.total).toBe(1);
  });

  it('gets a product by id', async () => {
    const existing = fixtureProduct();
    const { service } = makeService([existing]);

    const found = await service.get(superAdmin, existing.id);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.slug).toBe('pro-d');

    const missing = await service.get(superAdmin, '01890000-0000-7000-8000-00000000ffff');
    expect(missing.ok).toBe(false);
  });
});

describe('productService.listOrderable', () => {
  const orderingClientUser: CallerContext = {
    kind: 'user',
    id: '55555555-5555-7555-8555-555555555555',
    roles: [
      {
        ...assignment('client_user', CLIENT_ID),
        permissions: {
          products: 'all',
          groups: 'all',
          canPlaceOrders: true,
          canViewResults: false,
          canReleaseReports: false,
        },
      },
    ],
  };

  it('returns the client’s orderable catalogue with price-list rows, name A→Z', async () => {
    const active = fixtureProduct({ retailEnabled: true, retailPrice: 15000, retailCurrency: 'EUR' });
    const retired = fixtureProduct({
      id: '01890000-0000-7000-8000-000000000002',
      slug: 'old',
      name: 'Aardvark (retired)',
      status: 'retired',
    });
    const { service } = makeService([active, retired], {
      prices: [
        { productId: active.id, language: 'en', currency: 'EUR', unitPrice: 14000 },
        { productId: active.id, language: 'en', currency: 'USD', unitPrice: 16000 },
      ],
    });

    for (const caller of [superAdmin, clientAdmin, orderingClientUser]) {
      const result = await service.listOrderable(caller, CLIENT_ID);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value).toEqual([
        {
          id: active.id,
          name: 'PRO-D',
          defaultLanguage: 'en',
          availableLanguages: ['en'],
          reportPageSizeDefault: 'a4',
          prices: [
            { language: 'en', currency: 'EUR', unitPrice: 14000 },
            { language: 'en', currency: 'USD', unitPrice: 16000 },
          ],
          retailPrice: 15000,
          retailCurrency: 'EUR',
        },
      ]);
    }
  });

  it('excludes other organizations’ products from the client’s catalogue', async () => {
    const own = fixtureProduct();
    const foreign = fixtureProduct({
      id: '01890000-0000-7000-8000-000000000003',
      slug: 'foreign',
      name: 'Foreign',
      organizationId: OTHER_ORG_ID,
    });
    const { service } = makeService([own, foreign]);
    const result = await service.listOrderable(superAdmin, CLIENT_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((p) => p.id)).toEqual([own.id]);
  });

  it('includes restricted products only when the client holds a grant', async () => {
    const restricted = fixtureProduct({ defaultAccess: false });
    const without = await makeService([restricted]).service.listOrderable(superAdmin, CLIENT_ID);
    expect(without.ok).toBe(true);
    if (without.ok) expect(without.value).toEqual([]);

    const withGrant = await makeService([restricted], {
      grants: [{ clientId: CLIENT_ID, productId: restricted.id }],
    }).service.listOrderable(superAdmin, CLIENT_ID);
    expect(withGrant.ok).toBe(true);
    if (withGrant.ok) expect(withGrant.value.map((p) => p.id)).toEqual([restricted.id]);
  });

  it('denies callers who cannot place orders', async () => {
    const { service } = makeService([fixtureProduct()]);
    const viewer: CallerContext = {
      ...clientAdmin,
      roles: [assignment('client_user', CLIENT_ID)],
    };
    for (const caller of [
      viewer,
      { kind: 'api_key', id: 'key-1', roles: [] } as CallerContext,
    ]) {
      const result = await service.listOrderable(caller, CLIENT_ID);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('product/forbidden');
    }
  });

  it('denies client-scoped callers browsing another client’s catalogue', async () => {
    const { service } = makeService([fixtureProduct()]);
    const result = await service.listOrderable(clientAdmin, OTHER_ORG_CLIENT_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('product/forbidden');
  });

  it('returns client_not_found for unknown or malformed client ids', async () => {
    const { service } = makeService([fixtureProduct()]);
    for (const clientId of ['not-a-uuid', '01890000-0000-7000-8000-00000000dead']) {
      const result = await service.listOrderable(superAdmin, clientId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('product/client_not_found');
    }
  });
});
