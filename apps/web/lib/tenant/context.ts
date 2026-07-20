import type { TenantResolution } from '@assessify/services';
import { headers } from 'next/headers';

import { parseTenantHeader, TENANT_HEADER } from './tenant-header';

/**
 * Server-component access to the tenant context the middleware resolved for
 * this request (spec 11). Null when no tenant header is present (a route the
 * middleware matcher skips, or tests) — callers treat that as "no product
 * context" and fall back to Assessify defaults.
 */
export async function getTenantContext(): Promise<TenantResolution | null> {
  const requestHeaders = await headers();
  return parseTenantHeader(requestHeaders.get(TENANT_HEADER));
}

/** The product tenant for this request, or null on admin/platform/unknown hosts. */
export async function getProductTenant(): Promise<Extract<
  TenantResolution,
  { surface: 'product' }
> | null> {
  const tenant = await getTenantContext();
  return tenant?.surface === 'product' ? tenant : null;
}
