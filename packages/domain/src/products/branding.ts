import { z } from 'zod';

/**
 * Per-product branding config — the validated Zod shape for
 * `products.branding` (docs/spec/11-white-label-domains.md, "Branding
 * application"): `{ logoUrl, faviconUrl?, colors: { primary, primaryDark,
 * accent, surfaceTint, ink }, fontFamily?, emailFrom: { name, address } }`.
 *
 * Everything is optional because `products.branding` defaults to `{}` — the
 * Ember theme is the fallback for products without custom branding. F1
 * injects these values as CSS variables per request on respondent/public
 * surfaces.
 *
 * Logo/favicon are URL fields only. File upload is deliberately deferred:
 * Firebase Storage was dropped (owner decision, 2026-07-14) and the object
 * storage target (likely DO Spaces) is still undecided.
 */

/** #rgb or #rrggbb hex colour. */
export const hexColourSchema = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex colour like #C2410C');

/** http(s) URL — z.string().url() alone would admit javascript: etc. */
const brandAssetUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url('Must be a valid URL')
  .refine((value) => /^https?:\/\//i.test(value), { message: 'Must be an http(s) URL' });

export const brandingColorsSchema = z
  .object({
    primary: hexColourSchema,
    primaryDark: hexColourSchema,
    accent: hexColourSchema,
    surfaceTint: hexColourSchema,
    ink: hexColourSchema,
  })
  .partial()
  .strict();

export const brandingEmailFromSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().email('Must be a valid email address'),
  })
  .strict();

export const brandingConfigSchema = z
  .object({
    logoUrl: brandAssetUrlSchema.optional(),
    faviconUrl: brandAssetUrlSchema.optional(),
    colors: brandingColorsSchema.optional(),
    /** CSS font stack as a single string, e.g. `'Alte Haas', Georgia, serif`. */
    fontFamily: z.string().trim().min(1).max(300).optional(),
    /** Sender must be verified in SendGrid before use (spec 11). */
    emailFrom: brandingEmailFromSchema.optional(),
  })
  .strict();

export type BrandingColors = z.infer<typeof brandingColorsSchema>;
export type BrandingConfig = z.infer<typeof brandingConfigSchema>;
