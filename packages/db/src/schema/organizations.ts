import { char, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Organizations (owner decisions 2026-07-21 — Platform → Organization →
// Client → Assessment taker). The organization is the product-owner company:
// Stripe Connect onboarding and royalty SETTLEMENT identity live here, while
// royalty RATES (revenue_split_pct, royalty_policy) stay per product.

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  /** active | archived */
  status: text('status').notNull().default('active'),
  /** Stripe Connect account for royalty settlement (moved from products). */
  connectedStripeAccountId: text('connected_stripe_account_id'),
  /** Where settlement statements / payout notices go. */
  settlementEmail: text('settlement_email'),
  settlementCurrency: char('settlement_currency', { length: 3 }).notNull().default('EUR'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
