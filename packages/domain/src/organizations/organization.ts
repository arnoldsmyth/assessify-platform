import { z } from 'zod';

import { languageTagSchema } from '../products/product';

/**
 * Organization entity + payload schemas (owner decisions 2026-07-21 —
 * hierarchy Platform → Organization → Client → Assessment taker).
 *
 * The organization is the product owner company (e.g. the PRO-D publisher
 * owning the Premium/Advance/Core products). Stripe Connect onboarding and
 * royalty SETTLEMENT identity live here; royalty RATES stay per product.
 */

export const organizationStatusSchema = z.enum(['active', 'archived']);
export type OrganizationStatus = z.infer<typeof organizationStatusSchema>;

/**
 * URL-safe identifier. Unlike product slugs, org slugs never become DNS
 * hostnames, so no reserved list — just a stable lowercase handle.
 */
export const organizationSlugSchema = z
  .string()
  .trim()
  .min(2, 'Must be at least 2 characters')
  .max(63, 'Must be at most 63 characters')
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Lowercase letters, digits and hyphens only; must start and end with a letter or digit'
  );

const organizationNameSchema = z.string().trim().min(1, 'Required').max(200);

const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code, e.g. EUR');

export const createOrganizationSchema = z
  .object({
    name: organizationNameSchema,
    slug: organizationSlugSchema,
    settlementEmail: z.string().trim().email().nullable().optional(),
    settlementCurrency: currencyCodeSchema.default('EUR'),
  })
  .strict();

export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;
export type CreateOrganization = z.output<typeof createOrganizationSchema>;

/**
 * Update payload — everything optional. Status is not updatable here:
 * archiving is an explicit service operation. `connectedStripeAccountId` is
 * set by the Stripe Connect onboarding flow (spec 10), not by CRUD.
 */
export const updateOrganizationSchema = z
  .object({
    name: organizationNameSchema.optional(),
    slug: organizationSlugSchema.optional(),
    settlementEmail: z.string().trim().email().nullable().optional(),
    settlementCurrency: currencyCodeSchema.optional(),
  })
  .strict();

export type UpdateOrganizationInput = z.input<typeof updateOrganizationSchema>;
export type UpdateOrganization = z.output<typeof updateOrganizationSchema>;

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  /** Stripe Connect account for royalty settlement (moved from products). */
  connectedStripeAccountId: string | null;
  settlementEmail: string | null;
  settlementCurrency: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Product price list — orgs price their products per language edition
// (product, language, currency). NOT questionnaire_versions.variant: that
// axis is rater variants (self/manager).
// ---------------------------------------------------------------------------

export const upsertProductPriceSchema = z
  .object({
    productId: z.string().uuid(),
    /** Must be one of the product's availableLanguages (service-enforced). */
    language: languageTagSchema,
    currency: currencyCodeSchema,
    /** Integer minor units (spec 04 money convention). */
    unitPrice: z.number().int().nonnegative(),
  })
  .strict();

export type UpsertProductPriceInput = z.input<typeof upsertProductPriceSchema>;
export type UpsertProductPrice = z.output<typeof upsertProductPriceSchema>;

export interface ProductPrice {
  id: string;
  productId: string;
  language: string;
  currency: string;
  /** Integer minor units. */
  unitPrice: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Client product access — explicit grants for restricted products
// (products.defaultAccess = false). Org-default products need no grants.
// ---------------------------------------------------------------------------

export const clientProductAccessSchema = z
  .object({
    clientId: z.string().uuid(),
    productId: z.string().uuid(),
  })
  .strict();

export type ClientProductAccessInput = z.input<typeof clientProductAccessSchema>;

export interface ClientProductAccessGrant {
  clientId: string;
  productId: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Caller contexts — data source for the future admin context switcher.
// ---------------------------------------------------------------------------

/** One surface the caller can operate in, derived from role_assignments. */
export type CallerContextOption =
  | { kind: 'platform' }
  | { kind: 'organization'; id: string; name: string }
  | { kind: 'client'; id: string; name: string; organizationId: string };
