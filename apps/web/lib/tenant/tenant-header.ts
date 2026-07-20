import { brandingConfigSchema } from '@assessify/domain';
import type { TenantResolution } from '@assessify/services';
import { z } from 'zod';

/**
 * The middleware → server-component contract (spec 11: "Resolution result …
 * is attached via request headers to server components"). Pure encode/parse —
 * no Next.js imports — so it is unit-testable and shared by the middleware
 * and `getTenantContext()`.
 *
 * The middleware deletes any inbound headers with these names before setting
 * its own, so downstream code can trust them; the parser still re-validates
 * with Zod (boundary rule) and returns null on anything malformed.
 */

/** Full resolution payload, URI-component-encoded JSON. */
export const TENANT_HEADER = 'x-assessify-tenant';
/** Plain surface name for cheap checks without JSON parsing. */
export const SURFACE_HEADER = 'x-assessify-surface';

const tenantHeaderSchema: z.ZodType<TenantResolution> = z.discriminatedUnion('surface', [
  z.object({ surface: z.literal('admin') }).strict(),
  z.object({ surface: z.literal('platform') }).strict(),
  z
    .object({
      surface: z.literal('product'),
      productId: z.string().uuid(),
      productSlug: z.string().min(1),
      productName: z.string().min(1),
      clientId: z.string().uuid().nullable(),
      via: z.enum(['slug', 'custom_domain']),
      branding: brandingConfigSchema,
    })
    .strict(),
]);

export function encodeTenantHeader(tenant: TenantResolution): string {
  return encodeURIComponent(JSON.stringify(tenant));
}

/** Null when the header is absent or malformed — callers fall back to defaults. */
export function parseTenantHeader(value: string | null | undefined): TenantResolution | null {
  if (!value) return null;
  try {
    const parsed = tenantHeaderSchema.safeParse(JSON.parse(decodeURIComponent(value)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
