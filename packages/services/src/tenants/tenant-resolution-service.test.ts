import type { Product } from '@assessify/domain';
import type {
  ActiveCustomDomain,
  CustomDomainRepository,
  ProductRepository,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import { classifyHostname, normalizeHostname, type TenantHostConfig } from './hostname';
import { createTenantResolutionService } from './tenant-resolution-service';

const hosts: TenantHostConfig = {
  adminHostnames: ['app.assessify.ie', 'localhost', '127.0.0.1'],
  platformHostnames: ['assessify.ie', 'www.assessify.ie'],
  slugBaseDomains: ['assessify.ie', 'localhost'],
};

function fixtureProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: '01890000-0000-7000-8000-000000000001',
    slug: 'pro-d',
    name: 'PRO-D',
    status: 'active',
    branding: { colors: { primary: '#123456' }, logoUrl: 'https://cdn.example.com/logo.svg' },
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

interface Fixtures {
  products?: Product[];
  domains?: ActiveCustomDomain[];
}

function repos(fixtures: Fixtures) {
  const productList = fixtures.products ?? [];
  const products: ProductRepository = {
    findById: vi.fn(async (id: string) => productList.find((p) => p.id === id) ?? null),
    findBySlug: vi.fn(async (slug: string) => productList.find((p) => p.slug === slug) ?? null),
    insert: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
  };
  const customDomains: CustomDomainRepository = {
    findActiveByHostname: vi.fn(
      async (hostname: string) =>
        (fixtures.domains ?? []).find((d) => d.hostname === hostname) ?? null
    ),
    findActiveByProductId: vi.fn(async (productId: string) =>
      (fixtures.domains ?? []).filter((d) => d.productId === productId)
    ),
  };
  return { products, customDomains };
}

describe('normalizeHostname', () => {
  it('lowercases, strips ports and trailing dots', () => {
    expect(normalizeHostname('App.Assessify.IE:443')).toBe('app.assessify.ie');
    expect(normalizeHostname('assessify.ie.')).toBe('assessify.ie');
    expect(normalizeHostname('localhost:3000')).toBe('localhost');
  });

  it('handles IPv6 literals', () => {
    expect(normalizeHostname('[::1]:3000')).toBe('::1');
  });

  it('rejects garbage host headers', () => {
    expect(normalizeHostname('')).toBeNull();
    expect(normalizeHostname('foo_bar.example.com')).toBeNull();
    expect(normalizeHostname('evil host')).toBeNull();
    expect(normalizeHostname('host:notaport')).toBeNull();
    expect(normalizeHostname('-leading.example.com')).toBeNull();
  });
});

describe('classifyHostname', () => {
  it('matches admin hostnames first (app is never a slug)', () => {
    expect(classifyHostname('app.assessify.ie', hosts)).toEqual({ kind: 'admin' });
    expect(classifyHostname('localhost:3000', hosts)).toEqual({ kind: 'admin' });
    expect(classifyHostname('127.0.0.1:3000', hosts)).toEqual({ kind: 'admin' });
  });

  it('matches platform apex and www', () => {
    expect(classifyHostname('assessify.ie', hosts)).toEqual({ kind: 'platform' });
    expect(classifyHostname('WWW.assessify.ie', hosts)).toEqual({ kind: 'platform' });
  });

  it('parses single-label slug subdomains on each base domain', () => {
    expect(classifyHostname('pro-d.assessify.ie', hosts)).toEqual({ kind: 'slug', slug: 'pro-d' });
    expect(classifyHostname('pro-d.localhost:3000', hosts)).toEqual({
      kind: 'slug',
      slug: 'pro-d',
    });
  });

  it('sends deeper subdomains and foreign hosts to the custom-domain lookup', () => {
    expect(classifyHostname('a.b.assessify.ie', hosts)).toEqual({
      kind: 'custom',
      hostname: 'a.b.assessify.ie',
    });
    expect(classifyHostname('questionnaire.pro-d.com', hosts)).toEqual({
      kind: 'custom',
      hostname: 'questionnaire.pro-d.com',
    });
  });

  it('flags unparseable hosts as invalid', () => {
    expect(classifyHostname('not a host', hosts)).toEqual({ kind: 'invalid' });
  });
});

describe('tenant resolution service', () => {
  it('resolves the admin and platform surfaces without touching repositories', async () => {
    const { products, customDomains } = repos({});
    const service = createTenantResolutionService({ products, customDomains, hosts });

    await expect(service.resolve('app.assessify.ie')).resolves.toEqual({
      ok: true,
      value: { surface: 'admin' },
    });
    await expect(service.resolve('www.assessify.ie')).resolves.toEqual({
      ok: true,
      value: { surface: 'platform' },
    });
    expect(products.findBySlug).not.toHaveBeenCalled();
    expect(customDomains.findActiveByHostname).not.toHaveBeenCalled();
  });

  it('resolves a slug subdomain to the product with parsed branding', async () => {
    const { products, customDomains } = repos({ products: [fixtureProduct()] });
    const service = createTenantResolutionService({ products, customDomains, hosts });

    const result = await service.resolve('pro-d.assessify.ie');
    expect(result).toEqual({
      ok: true,
      value: {
        surface: 'product',
        productId: '01890000-0000-7000-8000-000000000001',
        productSlug: 'pro-d',
        productName: 'PRO-D',
        clientId: null,
        via: 'slug',
        branding: { colors: { primary: '#123456' }, logoUrl: 'https://cdn.example.com/logo.svg' },
      },
    });
  });

  it('resolves an active custom domain to its product and client', async () => {
    const { products, customDomains } = repos({
      products: [fixtureProduct()],
      domains: [
        {
          hostname: 'questionnaire.pro-d.com',
          productId: '01890000-0000-7000-8000-000000000001',
          clientId: '01890000-0000-7000-8000-00000000c11e',
        },
      ],
    });
    const service = createTenantResolutionService({ products, customDomains, hosts });

    const result = await service.resolve('questionnaire.pro-d.com');
    expect(result.ok).toBe(true);
    if (result.ok && result.value.surface === 'product') {
      expect(result.value.via).toBe('custom_domain');
      expect(result.value.clientId).toBe('01890000-0000-7000-8000-00000000c11e');
      expect(result.value.productSlug).toBe('pro-d');
    }
  });

  it('returns the same generic error for unknown, retired and invalid hosts', async () => {
    const { products, customDomains } = repos({
      products: [fixtureProduct({ status: 'retired' })],
    });
    const service = createTenantResolutionService({ products, customDomains, hosts });

    for (const host of ['pro-d.assessify.ie', 'nope.example.com', '!!!']) {
      const result = await service.resolve(host);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('tenant/unknown_host');
        // Generic by design: no hostname echo in the error.
        expect(JSON.stringify(result.error)).not.toContain(host);
      }
    }
  });

  it('falls back to empty branding when the stored blob is invalid', async () => {
    const { products, customDomains } = repos({
      products: [
        fixtureProduct({
          branding: { colors: { primary: 'chartreuse' } } as Product['branding'],
        }),
      ],
    });
    const service = createTenantResolutionService({ products, customDomains, hosts });

    const result = await service.resolve('pro-d.assessify.ie');
    expect(result.ok).toBe(true);
    if (result.ok && result.value.surface === 'product') {
      expect(result.value.branding).toEqual({});
    }
  });

  it('caches product resolutions for the TTL and refreshes after expiry', async () => {
    const { products, customDomains } = repos({ products: [fixtureProduct()] });
    let clock = 0;
    const service = createTenantResolutionService({
      products,
      customDomains,
      hosts,
      cacheTtlMs: 60_000,
      now: () => clock,
    });

    await service.resolve('pro-d.assessify.ie');
    await service.resolve('pro-d.assessify.ie:443');
    expect(products.findBySlug).toHaveBeenCalledTimes(1);

    clock = 59_999;
    await service.resolve('pro-d.assessify.ie');
    expect(products.findBySlug).toHaveBeenCalledTimes(1);

    clock = 60_001;
    await service.resolve('pro-d.assessify.ie');
    expect(products.findBySlug).toHaveBeenCalledTimes(2);
  });

  it('negative-caches unknown hosts with the shorter TTL', async () => {
    const { products, customDomains } = repos({});
    let clock = 0;
    const service = createTenantResolutionService({
      products,
      customDomains,
      hosts,
      negativeCacheTtlMs: 15_000,
      now: () => clock,
    });

    await service.resolve('unknown.example.com');
    await service.resolve('unknown.example.com');
    expect(customDomains.findActiveByHostname).toHaveBeenCalledTimes(1);

    clock = 15_001;
    await service.resolve('unknown.example.com');
    expect(customDomains.findActiveByHostname).toHaveBeenCalledTimes(2);
  });

  it('caps the cache size against hostile Host headers', async () => {
    const { products, customDomains } = repos({});
    const service = createTenantResolutionService({
      products,
      customDomains,
      hosts,
      maxCacheEntries: 2,
      now: () => 0,
    });

    await service.resolve('a.example.com');
    await service.resolve('b.example.com');
    await service.resolve('c.example.com'); // evicts a.example.com
    await service.resolve('a.example.com'); // miss again → repo hit
    expect(customDomains.findActiveByHostname).toHaveBeenCalledTimes(4);

    // b was evicted by re-adding a; c is still cached.
    await service.resolve('c.example.com');
    expect(customDomains.findActiveByHostname).toHaveBeenCalledTimes(4);
  });
});
