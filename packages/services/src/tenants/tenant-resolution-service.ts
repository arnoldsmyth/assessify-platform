import {
  brandingConfigSchema,
  err,
  ok,
  type BrandingConfig,
  type DomainError,
  type Result,
} from '@assessify/domain';
import type { CustomDomainRepository, ProductRepository } from '@assessify/repositories';

import {
  classifyHostname,
  tenantHostConfigSchema,
  type TenantHostConfig,
} from './hostname';

/**
 * Hostname → surface/tenant resolution (spec 11, spec 03 "The three web
 * surfaces and tenant resolution"). Called by the web middleware on every
 * request, so product lookups sit behind an in-process TTL cache.
 *
 * Cache-invalidation tradeoff (documented decision): spec 11 calls for
 * in-memory + Valkey with explicit busting on domain/product update. F1 ships
 * the in-process TTL layer only — after a branding edit, slug change, or
 * domain (de)activation, each web instance may serve the old resolution for
 * at most CACHE_TTL_MS (60s). That staleness bound is acceptable for
 * admin-assisted domain changes; F2 (domain lifecycle) adds the shared Valkey
 * layer + event-driven busting behind the same service interface. Unknown
 * hosts are negative-cached for a shorter TTL so a misconfigured DNS record
 * (or a scanner) cannot hammer Postgres, and the cache is size-capped because
 * the Host header is attacker-controlled input.
 */

export type TenantResolution =
  | { surface: 'admin' }
  | { surface: 'platform' }
  | {
      surface: 'product';
      productId: string;
      productSlug: string;
      productName: string;
      /** Set when resolved via a client-specific custom domain (spec 11). */
      clientId: string | null;
      /** How the hostname mapped to the product. */
      via: 'slug' | 'custom_domain';
      branding: BrandingConfig;
    };

export interface TenantResolutionService {
  /**
   * Resolve a raw Host header to a surface context. Unknown, retired and
   * invalid hostnames all return the same generic `tenant/unknown_host`
   * error — the serving path never reveals why a hostname is unknown.
   */
  resolve(rawHost: string): Promise<Result<TenantResolution>>;
}

export interface TenantResolutionServiceDeps {
  products: ProductRepository;
  customDomains: CustomDomainRepository;
  hosts: TenantHostConfig;
  /** Positive-cache TTL for resolved product hosts. Default 60s. */
  cacheTtlMs?: number;
  /** Negative-cache TTL for unknown hosts. Default 15s. */
  negativeCacheTtlMs?: number;
  /** Max cached hostnames (Host is attacker-controlled). Default 1000. */
  maxCacheEntries?: number;
  now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 15_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1000;

function unknownHost(): DomainError {
  // Deliberately generic: no hostname echo, no distinction between
  // "no such domain", "domain not active" and "product retired".
  return { code: 'tenant/unknown_host', message: 'Hostname not recognised' };
}

interface CacheEntry {
  expiresAt: number;
  value: Result<TenantResolution>;
}

export function createTenantResolutionService(
  deps: TenantResolutionServiceDeps
): TenantResolutionService {
  const hosts = tenantHostConfigSchema.parse(deps.hosts);
  const { products, customDomains } = deps;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const negativeCacheTtlMs = deps.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
  const maxCacheEntries = deps.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const now = deps.now ?? Date.now;

  const cache = new Map<string, CacheEntry>();

  function cacheSet(key: string, entry: CacheEntry): void {
    if (cache.size >= maxCacheEntries && !cache.has(key)) {
      // Drop the oldest entry (Map preserves insertion order).
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, entry);
  }

  function parseBranding(raw: unknown): BrandingConfig {
    // products.branding defaults to {}; an invalid blob must never take the
    // respondent surface down — fall back to the Ember defaults.
    const parsed = brandingConfigSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : {};
  }

  async function resolveProductHost(
    classification: { kind: 'slug'; slug: string } | { kind: 'custom'; hostname: string }
  ): Promise<Result<TenantResolution>> {
    if (classification.kind === 'slug') {
      const product = await products.findBySlug(classification.slug);
      if (!product || product.status !== 'active') return err(unknownHost());
      return ok({
        surface: 'product' as const,
        productId: product.id,
        productSlug: product.slug,
        productName: product.name,
        clientId: null,
        via: 'slug' as const,
        branding: parseBranding(product.branding),
      });
    }

    const domain = await customDomains.findActiveByHostname(classification.hostname);
    if (!domain) return err(unknownHost());
    const product = await products.findById(domain.productId);
    if (!product || product.status !== 'active') return err(unknownHost());
    return ok({
      surface: 'product' as const,
      productId: product.id,
      productSlug: product.slug,
      productName: product.name,
      clientId: domain.clientId,
      via: 'custom_domain' as const,
      branding: parseBranding(product.branding),
    });
  }

  return {
    async resolve(rawHost) {
      const classification = classifyHostname(rawHost, hosts);
      switch (classification.kind) {
        case 'invalid':
          return err(unknownHost());
        case 'admin':
          return ok({ surface: 'admin' });
        case 'platform':
          return ok({ surface: 'platform' });
        default: {
          const key =
            classification.kind === 'slug'
              ? `slug:${classification.slug}`
              : `host:${classification.hostname}`;
          const cached = cache.get(key);
          if (cached && cached.expiresAt > now()) return cached.value;

          const result = await resolveProductHost(classification);
          cacheSet(key, {
            value: result,
            expiresAt: now() + (result.ok ? cacheTtlMs : negativeCacheTtlMs),
          });
          return result;
        }
      }
    },
  };
}
