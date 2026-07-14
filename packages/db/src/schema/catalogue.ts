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

// Tenancy & catalogue (04 — Data Model)

export const products = pgTable('products', {
  id: uuid('id').primaryKey(),
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
  retailEnabled: boolean('retail_enabled').notNull().default(false),
  retailPrice: bigint('retail_price', { mode: 'number' }),
  retailCurrency: char('retail_currency', { length: 3 }),
  /** Stripe Connect (day-one field, transfers in phase 2) */
  connectedStripeAccountId: text('connected_stripe_account_id'),
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
    createdBy: uuid('created_by'),
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
