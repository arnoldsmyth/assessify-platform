import {
  bigint,
  boolean,
  char,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  ledgerEntryType,
  paymentProvider as paymentProviderEnum,
  paymentStatus,
  planType,
  settlementMethod,
} from './enums';
import { products } from './catalogue';
import { clients } from './parties';
import { orders, respondentSessions } from './orders';

// Billing (04 — Data Model)

/** One per client × product with a plan. */
export const entitlements = pgTable(
  'entitlements',
  {
    id: uuid('id').primaryKey(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    planType: planType('plan_type').notNull(),
    /** credit | seat | period */
    unit: text('unit').notNull().default('credit'),
    /** cached; derived from ledger, checked in tx */
    balance: integer('balance').notNull().default(0),
    /** contracted price per unit */
    unitPrice: bigint('unit_price', { mode: 'number' }),
    currency: char('currency', { length: 3 }),
    /** postpay: daily | weekly | monthly */
    billingCycle: text('billing_cycle'),
    /** licence/flat plans */
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    lowBalanceThreshold: integer('low_balance_threshold').default(5),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.clientId, t.productId, t.planType)]
);

/** APPEND-ONLY. Never UPDATE or DELETE rows (enforced by trigger + grants, see 0001 migration). */
export const entitlementLedger = pgTable('entitlement_ledger', {
  id: uuid('id').primaryKey(),
  entitlementId: uuid('entitlement_id')
    .notNull()
    .references(() => entitlements.id),
  entryType: ledgerEntryType('entry_type').notNull(),
  /** +purchase, -usage */
  delta: integer('delta').notNull(),
  orderId: uuid('order_id').references(() => orders.id),
  invoiceId: uuid('invoice_id'),
  note: text('note'),
  actor: text('actor'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey(),
  /** INV-YYMM-#####  (##### = client_number) — display/search only */
  reference: text('reference').unique().notNull(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  /** draft | sent | paid | void */
  status: text('status').notNull().default('draft'),
  currency: char('currency', { length: 3 }).notNull(),
  subtotal: bigint('subtotal', { mode: 'number' }).notNull(),
  tax: bigint('tax', { mode: 'number' }).notNull().default(0),
  total: bigint('total', { mode: 'number' }).notNull(),
  /** [{description, qty, unitPrice, orderIds[]}] */
  lines: jsonb('lines').notNull(),
  xeroInvoiceId: text('xero_invoice_id'),
  pushedToXeroAt: timestamp('pushed_to_xero_at', { withTimezone: true }),
  dueDate: date('due_date'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').references(() => orders.id),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  provider: paymentProviderEnum('provider').notNull(),
  /** Stripe PaymentIntent id etc. */
  providerRef: text('provider_ref'),
  /** card | us_bank_account | offline */
  method: text('method'),
  status: paymentStatus('status').notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  error: jsonb('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** APPEND-ONLY (enforced by trigger + grants, see 0001 migration). */
export const royaltyLedger = pgTable('royalty_ledger', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id),
  sessionId: uuid('session_id').references(() => respondentSessions.id),
  /** 'pct_net_revenue' | 'fixed_per_completion' */
  basis: text('basis').notNull(),
  /** the net revenue or unit count basis */
  basisAmount: bigint('basis_amount', { mode: 'number' }).notNull(),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  /** '2026-07' etc. */
  period: text('period').notNull(),
  settlementId: uuid('settlement_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const royaltySettlements = pgTable('royalty_settlements', {
  id: uuid('id').primaryKey(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id),
  periodFrom: date('period_from').notNull(),
  periodTo: date('period_to').notNull(),
  method: settlementMethod('method').notNull(),
  total: bigint('total', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull(),
  /** open | settled */
  status: text('status').notNull().default('open'),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  settledBy: text('settled_by'),
  externalRef: text('external_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
