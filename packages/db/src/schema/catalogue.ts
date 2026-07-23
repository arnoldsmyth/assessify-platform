import {
  bigint,
  boolean,
  char,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations';

// Tenancy & catalogue (04 — Data Model; org hierarchy per owner decisions
// 2026-07-21: Platform → Organization → Client → Assessment taker)

export const products = pgTable('products', {
  id: uuid('id').primaryKey(),
  /** Owning organization (product owner company). */
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  /** used for {slug}.assessify.ie */
  slug: text('slug').unique().notNull(),
  name: text('name').notNull(),
  /** active | retired */
  status: text('status').notNull().default('active'),
  /** {logoUrl, colors:{primary,accent,...}, fonts, emailFrom:{name,address}, faviconUrl} */
  branding: jsonb('branding').notNull().default({}),
  defaultLanguage: text('default_language').notNull().default('en'),
  availableLanguages: text('available_languages').array().notNull().default(['en']),
  /** {"partner_system":"XYZ-001", ...} */
  externalIds: jsonb('external_ids').notNull().default({}),
  /** see 08 (mode, endpoint ref, auth, payload/callback schema keys) */
  scoringConfig: jsonb('scoring_config').notNull(),
  /** see 13 */
  notificationDefaults: jsonb('notification_defaults').notNull().default({}),
  /** 'a4' | 'letter' */
  reportPageSizeDefault: text('report_page_size_default').notNull().default('a4'),
  /**
   * True = org-default: available to all the org's clients. False =
   * restricted: only clients with a `client_product_access` grant.
   */
  defaultAccess: boolean('default_access').notNull().default(true),
  retailEnabled: boolean('retail_enabled').notNull().default(false),
  retailPrice: bigint('retail_price', { mode: 'number' }),
  retailCurrency: char('retail_currency', { length: 3 }),
  /** Royalty RATES stay per product; settlement identity is on the org. */
  revenueSplitPct: numeric('revenue_split_pct', { precision: 5, scale: 2 }),
  /** {method, pctNet?, fixedAmount?, hybrid?, settlement, period, externalIdKey} */
  royaltyPolicy: jsonb('royalty_policy'),
  timezone: text('timezone').notNull().default('Europe/Dublin'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const questionnaireVersions = pgTable(
  'questionnaire_versions',
  {
    id: uuid('id').primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    version: integer('version').notNull(),
    /** 'self' | rater variant key (e.g. 'manager','peer') */
    variant: text('variant').notNull().default('self'),
    /** validated against questionnaire-schema (07) */
    definition: jsonb('definition').notNull(),
    /** draft | active | retired */
    status: text('status').notNull().default('draft'),
    /** Better Auth user id of the importer (text, not uuid — see auth.ts `user.id`); null for system imports. */
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.productId, t.version, t.variant)]
);

export const reportTemplateVersions = pgTable(
  'report_template_versions',
  {
    id: uuid('id').primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    version: integer('version').notNull(),
    /** maps to a React template component in code */
    componentKey: text('component_key').notNull(),
    /** layout/config consumed by the component (09) */
    config: jsonb('config').notNull(),
    status: text('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.productId, t.version)]
);

/**
 * Org-set price list per language edition (owner decision 2026-07-21):
 * PLATFORM creates products; ORGS price them per (language, currency) — e.g.
 * PRO-D Premium English vs Spanish priced differently. Deliberately NOT on
 * `questionnaire_versions.variant` (that axis is rater variants: self/manager).
 */
export const productPrices = pgTable(
  'product_prices',
  {
    id: uuid('id').primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    /** BCP47 language tag — must be one of the product's available languages. */
    language: text('language').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    /** Integer minor units (spec 04 money convention). */
    unitPrice: bigint('unit_price', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.productId, t.language, t.currency)]
);

export const translationStrings = pgTable(
  'translation_strings',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    stringKey: text('string_key').notNull(),
    /** BCP47 (en, fr, pt-BR, tl) */
    language: text('language').notNull(),
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.stringKey, t.language] })]
);
