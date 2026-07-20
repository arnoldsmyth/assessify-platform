import type { TenantResolution } from '@assessify/services';

/**
 * Pure per-request routing policy (spec 11: "On a white-label host, only
 * (respondent) and (public) route groups are servable; admin routes 404").
 * Extracted from the middleware so it is unit-testable without Next.js.
 *
 * Admin hosts are deliberately unrestricted: localhost is an admin hostname
 * in dev, and the respondent/public surfaces must stay reachable there
 * (Ember-default branding, no product context).
 */

/** Path prefixes that belong to the Assessify-branded admin surface. */
const ADMIN_ONLY_PREFIXES = ['/admin', '/login'];

function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isPathAllowedForSurface(
  surface: TenantResolution['surface'],
  pathname: string
): boolean {
  if (surface === 'admin') return true;
  return !ADMIN_ONLY_PREFIXES.some((prefix) => hasPrefix(pathname, prefix));
}
