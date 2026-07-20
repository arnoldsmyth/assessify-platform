import { getTenantResolutionService } from '@assessify/services';
import { NextResponse, type NextRequest } from 'next/server';

import { getServerEnv } from '@/lib/env';
import { isPathAllowedForSurface } from '@/lib/tenant/routing';
import { encodeTenantHeader, SURFACE_HEADER, TENANT_HEADER } from '@/lib/tenant/tenant-header';

/**
 * Tenant-resolution middleware (spec 11, spec 03 "The three web surfaces and
 * tenant resolution"). Every page request resolves its Host header to a
 * surface context:
 *
 *   admin hostnames                     → admin surface
 *   platform apex/www                   → platform public surface
 *   {slug}.<base domain>                → product surface (by slug)
 *   active custom_domains row           → product surface (white-label)
 *   anything else                       → minimal unbranded 404
 *
 * The hostname → product lookup goes through the tenant resolution service
 * (in-process TTL cache — spec 11's Valkey layer + explicit busting arrives
 * with F2), which is why this middleware runs on the Node.js runtime (stable
 * since Next 15.5): the service layer sits on pg, which the edge runtime
 * cannot host. The resolution result travels to server components via
 * request headers; inbound copies of those headers are always stripped, so
 * downstream code can trust them.
 */

export const config = {
  runtime: 'nodejs',
  // Page routes only: API routes authenticate per-call (api/v1 keys, webhook
  // signatures, Better Auth) and the internal report-print route is reached
  // by the pdf-service, not a browser. Static assets are host-agnostic.
  matcher: ['/((?!api/|_next/|report-print/|favicon\\.ico|robots\\.txt|sitemap\\.xml).*)'],
};

/** Spec 11: unknown hostnames get an unbranded, minimal 404. */
function minimalNotFound(): NextResponse {
  return new NextResponse('404 — Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const env = getServerEnv();
  const tenants = getTenantResolutionService({
    adminHostnames: env.ADMIN_HOSTNAMES,
    platformHostnames: env.PLATFORM_HOSTNAMES,
    slugBaseDomains: env.PRODUCT_SLUG_BASE_DOMAINS,
  });

  const resolution = await tenants.resolve(request.headers.get('host') ?? '');
  if (!resolution.ok) return minimalNotFound();

  const tenant = resolution.value;
  if (!isPathAllowedForSurface(tenant.surface, request.nextUrl.pathname)) {
    return minimalNotFound();
  }

  const requestHeaders = new Headers(request.headers);
  // Never trust inbound tenant headers — they are set here or not at all.
  requestHeaders.delete(TENANT_HEADER);
  requestHeaders.delete(SURFACE_HEADER);
  requestHeaders.set(SURFACE_HEADER, tenant.surface);
  requestHeaders.set(TENANT_HEADER, encodeTenantHeader(tenant));

  return NextResponse.next({ request: { headers: requestHeaders } });
}
