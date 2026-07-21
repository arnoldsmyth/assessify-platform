import { z } from 'zod';

import {
  internalScoringDefinitionSchema,
  scoringModeSchema,
  scoringRetrievalModeSchema,
} from '../scoring';
import { brandingConfigSchema, type BrandingConfig } from './branding';

/**
 * Product entity + payload schemas (docs/spec/04-data-model.md `products`
 * table; docs/spec/11-white-label-domains.md for slug/branding semantics).
 */

// ---------------------------------------------------------------------------
// Slug — becomes the {slug}.assessify.ie subdomain (spec 11), so it must be a
// valid DNS label and must not collide with platform hostnames.
// ---------------------------------------------------------------------------

export const RESERVED_PRODUCT_SLUGS = [
  'admin',
  'api',
  'app', // app.assessify.ie → admin surface (spec 11)
  'assets',
  'cdn',
  'dev',
  'mail',
  'smtp',
  'staging',
  'status',
  'test',
  'www',
] as const;

export const productSlugSchema = z
  .string()
  .trim()
  .min(2, 'Must be at least 2 characters')
  .max(63, 'Must be at most 63 characters (DNS label limit)')
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Lowercase letters, digits and hyphens only; must start and end with a letter or digit'
  )
  .refine((slug) => !(RESERVED_PRODUCT_SLUGS as readonly string[]).includes(slug), {
    message: 'This slug is reserved for platform hostnames',
  });

// ---------------------------------------------------------------------------
// Supporting field schemas
// ---------------------------------------------------------------------------

export const productStatusSchema = z.enum(['active', 'retired']);
export type ProductStatus = z.infer<typeof productStatusSchema>;

/** BCP 47-ish language tag: en, fr, pt-BR, tl (spec 04 translation_strings). */
export const languageTagSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Must be a BCP 47 language tag (e.g. en, pt-BR)');

export const reportPageSizeSchema = z.enum(['a4', 'letter']);
export type ReportPageSize = z.infer<typeof reportPageSizeSchema>;

/** `products.scoring_config` shape per docs/spec/08-scoring-module.md. */
export const scoringConfigSchema = z
  .object({
    mode: scoringModeSchema,
    /**
     * `async_external` result retrieval (owner update 2026-07-14): `callback`
     * (engine POSTs to our webhook — E2) or `pull` (we poll the engine's API
     * for the finished scores, e.g. the rebuilt PRO-D service). Defaults to
     * `callback` when omitted.
     */
    retrieval: scoringRetrievalModeSchema.optional(),
    engineKey: z.string().trim().min(1).max(100).optional(),
    /** Declarative definition for the internal scale-sum engine (spec 08). */
    definition: internalScoringDefinitionSchema.optional(),
    endpoint: z.string().trim().url().optional(),
    auth: z
      .object({
        type: z.enum(['api_key', 'hmac', 'oauth2']),
        /** Env-var name — secrets are never stored in the DB (spec 08). */
        secretRef: z.string().trim().min(1).max(200),
      })
      .strict()
      .optional(),
    timeoutSeconds: z.number().int().min(1).max(600).default(30),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    payloadMapping: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.mode === 'async_external' && !config.endpoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoint'],
        message: 'An endpoint is required for async_external scoring',
      });
    }
  });

export type ScoringConfig = z.output<typeof scoringConfigSchema>;

const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code, e.g. EUR');

const productNameSchema = z.string().trim().min(1, 'Required').max(200);

const timezoneSchema = z.string().trim().min(1).max(64);

const externalIdsSchema = z.record(z.string(), z.string());

// ---------------------------------------------------------------------------
// Cross-field invariants — shared by create (via superRefine) and by the
// service when validating an update merged onto the existing product.
// ---------------------------------------------------------------------------

export interface ProductInvariantsInput {
  defaultLanguage: string;
  availableLanguages: string[];
  retailEnabled: boolean;
  retailPrice?: number | null;
  retailCurrency?: string | null;
}

export interface ProductInvariantIssue {
  path: string;
  message: string;
}

export function productInvariantIssues(input: ProductInvariantsInput): ProductInvariantIssue[] {
  const issues: ProductInvariantIssue[] = [];
  if (!input.availableLanguages.includes(input.defaultLanguage)) {
    issues.push({
      path: 'availableLanguages',
      message: 'Available languages must include the default language',
    });
  }
  if (input.retailEnabled) {
    if (input.retailPrice === null || input.retailPrice === undefined) {
      issues.push({
        path: 'retailPrice',
        message: 'A retail price (integer minor units) is required when retail is enabled',
      });
    }
    if (!input.retailCurrency) {
      issues.push({
        path: 'retailCurrency',
        message: 'A retail currency is required when retail is enabled',
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export const createProductSchema = z
  .object({
    /** Owning organization — platform assigns products to orgs (owner decision 2026-07-21). */
    organizationId: z.string().uuid(),
    slug: productSlugSchema,
    name: productNameSchema,
    /** True = available to all the org's clients; false = per-client grants. */
    defaultAccess: z.boolean().default(true),
    branding: brandingConfigSchema.default({}),
    defaultLanguage: languageTagSchema.default('en'),
    availableLanguages: z.array(languageTagSchema).min(1).default(['en']),
    scoringConfig: scoringConfigSchema.default({ mode: 'sync_internal' }),
    notificationDefaults: z.record(z.string(), z.unknown()).default({}),
    externalIds: externalIdsSchema.default({}),
    reportPageSizeDefault: reportPageSizeSchema.default('a4'),
    retailEnabled: z.boolean().default(false),
    /** Integer minor units (cents) — spec 04 money convention. */
    retailPrice: z.number().int().nonnegative().nullable().optional(),
    retailCurrency: currencyCodeSchema.nullable().optional(),
    timezone: timezoneSchema.default('Europe/Dublin'),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const issue of productInvariantIssues(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.path.split('.'),
        message: issue.message,
      });
    }
  });

export type CreateProductInput = z.input<typeof createProductSchema>;
export type CreateProduct = z.output<typeof createProductSchema>;

/**
 * Update payload — everything optional; the service validates cross-field
 * invariants against the merge of this patch onto the existing product.
 * Status is not updatable here: archiving is an explicit service operation.
 * Billing/royalty fields (revenue split, Stripe account, royalty policy) are
 * managed by the billing epic (spec 10), not by product CRUD.
 */
export const updateProductSchema = z
  .object({
    slug: productSlugSchema.optional(),
    name: productNameSchema.optional(),
    /** Org reassignment is NOT here — use the explicit assignProductToOrg operation. */
    defaultAccess: z.boolean().optional(),
    branding: brandingConfigSchema.optional(),
    defaultLanguage: languageTagSchema.optional(),
    availableLanguages: z.array(languageTagSchema).min(1).optional(),
    scoringConfig: scoringConfigSchema.optional(),
    notificationDefaults: z.record(z.string(), z.unknown()).optional(),
    externalIds: externalIdsSchema.optional(),
    reportPageSizeDefault: reportPageSizeSchema.optional(),
    retailEnabled: z.boolean().optional(),
    retailPrice: z.number().int().nonnegative().nullable().optional(),
    retailCurrency: currencyCodeSchema.nullable().optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();

export type UpdateProductInput = z.input<typeof updateProductSchema>;
export type UpdateProduct = z.output<typeof updateProductSchema>;

export const listProductsQuerySchema = z.object({
  status: productStatusSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

export type ListProductsQueryInput = z.input<typeof listProductsQuerySchema>;
export type ListProductsQuery = z.output<typeof listProductsQuerySchema>;

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

export interface Product {
  id: string;
  /** Owning organization (product owner company). */
  organizationId: string;
  /** DNS-label slug; serves {slug}.assessify.ie (spec 11). */
  slug: string;
  name: string;
  status: ProductStatus;
  /** True = org-default (all the org's clients); false = restricted (grants). */
  defaultAccess: boolean;
  branding: BrandingConfig;
  defaultLanguage: string;
  availableLanguages: string[];
  externalIds: Record<string, string>;
  scoringConfig: ScoringConfig;
  notificationDefaults: Record<string, unknown>;
  reportPageSizeDefault: ReportPageSize;
  retailEnabled: boolean;
  /** Integer minor units. */
  retailPrice: number | null;
  retailCurrency: string | null;
  /** Royalty RATES stay per product; settlement identity lives on the org. */
  revenueSplitPct: number | null;
  royaltyPolicy: Record<string, unknown> | null;
  timezone: string;
  createdAt: Date;
  updatedAt: Date;
}
