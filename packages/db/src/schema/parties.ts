import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { roleName } from './enums';
import { citext } from './helpers';
import { products } from './catalogue';

// Parties (04 — Data Model)

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey(),
  /** from client_number_seq; used in INV reference */
  clientNumber: integer('client_number').unique().notNull(),
  name: text('name').notNull(),
  /** exactly one row true: the retail umbrella client */
  isPlatformRetail: boolean('is_platform_retail').notNull().default(false),
  billingEmail: text('billing_email'),
  billingAddress: jsonb('billing_address'),
  defaultCurrency: char('default_currency', { length: 3 }).notNull().default('EUR'),
  xeroContactId: text('xero_contact_id'),
  timezone: text('timezone').notNull().default('Europe/Dublin'),
  /** see 13 */
  notificationOverrides: jsonb('notification_overrides'),
  /** 'legacy' for imports */
  source: text('source').notNull().default('native'),
  legacyId: text('legacy_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Better Auth manages its own user/session/account tables.
 * This table extends its user record.
 */
export const userProfiles = pgTable('user_profiles', {
  /** FK to Better Auth user.id (not enforced — table owned by Better Auth) */
  userId: text('user_id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull(),
    role: roleName('role').notNull(),
    /** required for assessment_admin */
    productId: uuid('product_id').references(() => products.id),
    /** required for client_admin / client_user */
    clientId: uuid('client_id').references(() => clients.id),
    /** client_user restrictions (05) */
    permissions: jsonb('permissions').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.userId, t.role, t.productId, t.clientId)]
);

/** Persistent identity across a lifetime of assessments. */
export const respondents = pgTable(
  'respondents',
  {
    id: uuid('id').primaryKey(),
    email: citext('email'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    /** set if they created an account (retail Pattern 4) */
    userId: text('user_id'),
    language: text('language'),
    source: text('source').notNull().default('native'),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // dedupe anchor, NOT unique (PII deletion may null it)
  (t) => [index('respondents_email_idx').on(t.email)]
);

/** Projects / cohorts / tags. */
export const clientGroups = pgTable(
  'client_groups',
  {
    id: uuid('id').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    name: text('name').notNull(),
    /** tag | project | team */
    kind: text('kind').notNull().default('tag'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.clientId, t.name)]
);
