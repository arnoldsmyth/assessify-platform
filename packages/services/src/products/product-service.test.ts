import type { Product } from '@assessify/domain';
import type {
  ProductListQuery,
  ProductPatch,
  ProductRepository,
} from '@assessify/repositories';
import { describe, expect, it } from 'vitest';

import { createProductService, type Actor } from './product-service';

const superAdmin: Actor = { userId: '11111111-1111-7111-8111-111111111111', role: 'super_admin' };
const clientAdmin: Actor = { userId: '22222222-2222-7222-8222-222222222222', role: 'client_admin' };

function fixtureProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: '01890000-0000-7000-8000-000000000001',
    slug: 'pro-d',
    name: 'PRO-D',
    status: 'active',
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
    connectedStripeAccountId: null,
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

function makeService(seed: Product[] = []) {
  const { repo, rows } = makeRepo(seed);
  const service = createProductService({
    products: repo,
    now: () => new Date('2026-07-14T12:00:00Z'),
  });
  return { service, rows };
}

describe('productService.create', () => {
  it('creates a product with defaults applied (happy path)', async () => {
    const { service, rows } = makeService();

    const result = await service.create(superAdmin, {
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
  });

  it('accepts a full branding config', async () => {
    const { service } = makeService();

    const result = await service.create(superAdmin, {
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

  it('rejects a duplicate slug', async () => {
    const { service } = makeService([fixtureProduct()]);

    const result = await service.create(superAdmin, { slug: 'pro-d', name: 'Copycat' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('product/slug_taken');
    }
  });

  it('rejects invalid branding (bad colour, bad logo URL)', async () => {
    const { service } = makeService();

    const result = await service.create(superAdmin, {
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
      const result = await service.create(superAdmin, { slug, name: 'X' });
      expect(result.ok, `slug "${slug}" should be rejected`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('product/validation');
    }
  });

  it('enforces retail and language invariants', async () => {
    const { service } = makeService();

    const retail = await service.create(superAdmin, {
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
