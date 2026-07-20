import { z } from 'zod';

/**
 * Pure hostname classification for tenant resolution (spec 11 —
 * "Hostname → tenant resolution"). No I/O here: the middleware and the
 * resolution service both build on these functions, and they are unit-tested
 * without a database.
 *
 * Resolution order (spec 11):
 *   1. admin hostname            → admin surface
 *   2. platform apex/www         → platform marketing/public
 *   3. `{slug}.<base domain>`    → product by slug
 *   4. anything else             → custom_domains candidate (DB lookup)
 */

/** RFC-1123-ish hostname: dot-separated labels, letters/digits/hyphens. */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/;

/** Normalised (lowercase, no port/trailing dot) hostname. */
export const hostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(HOSTNAME_RE, 'Must be a valid hostname');

const hostListSchema = z.array(hostnameSchema).min(1);

/**
 * Platform host configuration — which hostnames mean "admin", "platform
 * marketing", and which base domains serve `{slug}.` product subdomains.
 * Provided by the composition root from env (apps/web/lib/env.ts) so dev
 * (localhost) and prod (assessify.ie) differ only in config.
 */
export const tenantHostConfigSchema = z
  .object({
    /** e.g. ['app.assessify.ie', 'localhost', '127.0.0.1'] */
    adminHostnames: hostListSchema,
    /** e.g. ['assessify.ie', 'www.assessify.ie'] */
    platformHostnames: hostListSchema,
    /** Suffixes serving {slug}. subdomains, e.g. ['assessify.ie', 'localhost']. */
    slugBaseDomains: hostListSchema,
  })
  .strict();

export type TenantHostConfig = z.infer<typeof tenantHostConfigSchema>;

export type HostClassification =
  | { kind: 'admin' }
  | { kind: 'platform' }
  | { kind: 'slug'; slug: string }
  | { kind: 'custom'; hostname: string }
  | { kind: 'invalid' };

/**
 * Normalise a raw Host header: lowercase, strip the port and any trailing
 * dot. Returns null when the value is not a plausible hostname (garbage Host
 * headers are treated as unknown hosts, never echoed anywhere).
 */
export function normalizeHostname(rawHost: string): string | null {
  let host = rawHost.trim().toLowerCase();
  // IPv6 literals ([::1]:3000) — keep the bracket content as-is.
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return null;
    host = host.slice(1, end);
    // Minimal sanity check; IPv6 hosts only ever match exact config entries.
    return /^[0-9a-f:]+$/.test(host) ? host : null;
  }
  const colon = host.indexOf(':');
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port)) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  const parsed = hostnameSchema.safeParse(host);
  return parsed.success ? parsed.data : null;
}

/**
 * Classify a raw Host header against the platform host config. Admin and
 * platform hostnames win over slug-subdomain matching, so `app.assessify.ie`
 * never resolves as the product slug "app" (those slugs are also reserved —
 * RESERVED_PRODUCT_SLUGS in @assessify/domain).
 */
export function classifyHostname(rawHost: string, config: TenantHostConfig): HostClassification {
  const host = normalizeHostname(rawHost);
  if (!host) return { kind: 'invalid' };

  if (config.adminHostnames.includes(host)) return { kind: 'admin' };
  if (config.platformHostnames.includes(host)) return { kind: 'platform' };

  for (const base of config.slugBaseDomains) {
    if (host.length > base.length + 1 && host.endsWith(`.${base}`)) {
      const label = host.slice(0, -(base.length + 1));
      // Only single-label subdomains are slugs; deeper names fall through to
      // the custom-domain lookup.
      if (!label.includes('.')) return { kind: 'slug', slug: label };
    }
  }

  return { kind: 'custom', hostname: host };
}
