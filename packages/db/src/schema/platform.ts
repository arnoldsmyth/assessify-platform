import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { domainStatus } from './enums';
import { products } from './catalogue';
import { clients } from './parties';

// Platform / integration (04 — Data Model)

export const customDomains = pgTable('custom_domains', {
  id: uuid('id').primaryKey(),
  /** 'questionnaire.pro-d.com' */
  hostname: text('hostname').unique().notNull(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  /** optional: client-specific domain */
  clientId: uuid('client_id').references(() => clients.id),
  status: domainStatus('status').notNull().default('pending_dns'),
  verificationToken: text('verification_token').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  /** SHA-256 of 'ak_live_...' secret; prefix stored for display */
  keyHash: text('key_hash').unique().notNull(),
  keyPrefix: text('key_prefix').notNull(),
  clientId: uuid('client_id').references(() => clients.id),
  productId: uuid('product_id').references(() => products.id),
  /** ['orders:write','results:read',...] */
  scopes: text('scopes').array().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: uuid('id').primaryKey(),
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id),
  clientId: uuid('client_id').references(() => clients.id),
  productId: uuid('product_id').references(() => products.id),
  url: text('url').notNull(),
  /** HMAC signing secret */
  secret: text('secret').notNull(),
  /** ['order.completed','report.ready',...] */
  events: text('events').array().notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey(),
  subscriptionId: uuid('subscription_id')
    .notNull()
    .references(() => webhookSubscriptions.id),
  event: text('event').notNull(),
  /** Append-only payload — a trigger blocks changing event/payload (0001 migration). */
  payload: jsonb('payload').notNull(),
  /** pending | delivered | failed */
  status: text('status').notNull().default('pending'),
  httpStatus: integer('http_status'),
  attempts: integer('attempts').notNull().default(0),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
});

export const notificationLog = pgTable('notification_log', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id'),
  sessionId: uuid('session_id'),
  /** invitation | reminder | report_ready | completion_notice | invoice */
  kind: text('kind').notNull(),
  /** purged on GDPR erasure for the respondent */
  recipient: text('recipient').notNull(),
  template: text('template').notNull(),
  language: text('language'),
  providerMessageId: text('provider_message_id'),
  /** queued | sent | delivered | opened | bounced | failed */
  status: text('status').notNull().default('queued'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** APPEND-ONLY (enforced by trigger + grants, see 0001 migration). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    /** user | respondent | system | api_key */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    /** 'order.status_changed', 'report.downloaded', ... */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_entity_idx').on(t.entityType, t.entityId, t.createdAt)]
);

export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
