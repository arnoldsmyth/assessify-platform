import {
  bigint,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import {
  orderStatus,
  orderType,
  paymentProvider as paymentProviderEnum,
  reportModel,
  scoringMode,
  sessionStatus,
} from './enums';
import { products, questionnaireVersions, reportTemplateVersions } from './catalogue';
import { clientGroups, clients, respondents } from './parties';

// Orders & fulfilment (04 — Data Model)

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey(),
    /** 'ORD-' || lpad(nextval('order_ref_seq')::text, 5, '0') — display/search only */
    reference: text('reference').unique().notNull(),
    type: orderType('type').notNull(),
    status: orderStatus('status').notNull().default('draft'),
    /** retail orders use the platform retail client */
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    /** pinned at creation */
    questionnaireVersionId: uuid('questionnaire_version_id')
      .notNull()
      .references(() => questionnaireVersions.id),
    reportTemplateVersionId: uuid('report_template_version_id').references(
      () => reportTemplateVersions.id
    ),
    reportLanguage: text('report_language').notNull().default('en'),
    reportModel: reportModel('report_model').notNull().default('individual'),
    currency: char('currency', { length: 3 }).notNull(),
    subtotal: bigint('subtotal', { mode: 'number' }).notNull().default(0),
    discountTotal: bigint('discount_total', { mode: 'number' }).notNull().default(0),
    total: bigint('total', { mode: 'number' }).notNull().default(0),
    paymentProvider: paymentProviderEnum('payment_provider'),
    /** set when paid by entitlement draw-down (no FK — entitlements owned by billing) */
    entitlementId: uuid('entitlement_id'),
    /** order-level override (13) */
    notificationPolicy: jsonb('notification_policy'),
    /** legacy 'silent mode' (partner API) */
    suppressNotifications: boolean('suppress_notifications').notNull().default(false),
    /** group orders */
    expectedRespondents: integer('expected_respondents'),
    /** report page size override */
    pageSize: text('page_size'),
    isTest: boolean('is_test').notNull().default(false),
    /** legacy upgrades linkage */
    relatedOrderId: uuid('related_order_id').references((): AnyPgColumn => orders.id),
    placedByUserId: text('placed_by_user_id'),
    /** admin | client | retail | api */
    placedVia: text('placed_via').notNull().default('admin'),
    /** populated in *_error states */
    errorDetail: jsonb('error_detail'),
    source: text('source').notNull().default('native'),
    legacyId: text('legacy_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_client_idx').on(t.clientId, t.status),
    index('orders_product_idx').on(t.productId, t.status, t.createdAt),
  ]
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    lineNo: integer('line_no').notNull(),
    description: text('description').notNull(),
    unitPrice: bigint('unit_price', { mode: 'number' }).notNull(),
    discount: bigint('discount', { mode: 'number' }).notNull().default(0),
    quantity: integer('quantity').notNull().default(1),
  },
  (t) => [unique().on(t.orderId, t.lineNo)]
);

export const orderGroupLinks = pgTable(
  'order_group_links',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    groupId: uuid('group_id')
      .notNull()
      .references(() => clientGroups.id),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.groupId] })]
);

/** THE central fulfilment record: one person × one assessment. */
export const respondentSessions = pgTable(
  'respondent_sessions',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    /** null until self-registration (patterns 3/5) */
    respondentId: uuid('respondent_id').references(() => respondents.id),
    /** the URL secret; distinct from id */
    token: uuid('token').unique().notNull(),
    /** bcrypt; null for batch-code sessions */
    pinHash: text('pin_hash'),
    status: sessionStatus('status').notNull().default('created'),
    /** false for raters in 360 orders */
    isFocal: boolean('is_focal').notNull().default(true),
    /** 'manager' | 'peer' | ... (per product config) */
    raterRelationship: text('rater_relationship'),
    /** may differ per rater variant */
    questionnaireVersionId: uuid('questionnaire_version_id')
      .notNull()
      .references(() => questionnaireVersions.id),
    /** respondent's current display language */
    language: text('language'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    reminderCount: integer('reminder_count').notNull().default(0),
    lastReminderAt: timestamp('last_reminder_at', { withTimezone: true }),
    remindersSuppressed: boolean('reminders_suppressed').notNull().default(false),
    /** scored output (dimension scores, bands, narrative keys) */
    scores: jsonb('scores'),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
    source: text('source').notNull().default('native'),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sessions_order_idx').on(t.orderId),
    index('sessions_status_idx').on(t.status, t.lastReminderAt),
  ]
);

/** Pattern 3: shared link. */
export const groupTokens = pgTable('group_tokens', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id')
    .unique()
    .notNull()
    .references(() => orders.id),
  token: uuid('token').unique().notNull(),
  pinHash: text('pin_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  maxRespondents: integer('max_respondents'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Pattern 5: single-use codes. */
export const redemptionCodes = pgTable('redemption_codes', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id),
  /** 8-char safe alphabet (ABCDEFGHJKLMNPQRTUVWXY346789) */
  code: text('code').unique().notNull(),
  /** issued | redeemed | expired | void */
  status: text('status').notNull().default('issued'),
  redeemedSessionId: uuid('redeemed_session_id').references(() => respondentSessions.id),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

export const scoringJobs = pgTable('scoring_jobs', {
  id: uuid('id').primaryKey(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => respondentSessions.id),
  mode: scoringMode('mode').notNull(),
  /** queued | dispatched | awaiting_callback | completed | failed */
  status: text('status').notNull().default('queued'),
  /** HMAC key for async callback verification (08) */
  callbackTokenHash: text('callback_token_hash'),
  requestPayload: jsonb('request_payload'),
  responsePayload: jsonb('response_payload'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id),
  /** null for aggregate reports */
  sessionId: uuid('session_id').references(() => respondentSessions.id),
  templateVersionId: uuid('template_version_id')
    .notNull()
    .references(() => reportTemplateVersions.id),
  /** individual | aggregate */
  kind: text('kind').notNull().default('individual'),
  /** pending | ready | released */
  status: text('status').notNull().default('pending'),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releasedBy: text('released_by'),
  /** Firebase Storage path; set only for migrated reports */
  legacyPdfPath: text('legacy_pdf_path'),
  /** assembled render data snapshot (09) */
  data: jsonb('data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Time-limited external sharing. */
export const reportAccessLinks = pgTable('report_access_links', {
  id: uuid('id').primaryKey(),
  reportId: uuid('report_id')
    .notNull()
    .references(() => reports.id),
  token: uuid('token').unique().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
