import { pgEnum } from 'drizzle-orm/pg-core';

// Enums from docs/spec/04-data-model.md — normative, do not reorder existing values.

export const orderType = pgEnum('order_type', [
  'named',
  'bulk_named',
  'multi_rater',
  'group',
  'retail',
  'batch_code',
]);

export const orderStatus = pgEnum('order_status', [
  'draft',
  'pending',
  'approved',
  'sent',
  'processing_report',
  'completed',
  'cancelled',
  'payment_error',
  'email_error',
  'on_hold',
  'refunded',
  'resend_email',
  'scoring_error',
]);

export const sessionStatus = pgEnum('session_status', [
  'created',
  'invited',
  'started',
  'completed',
  'awaiting_scores',
  'scored',
  'report_ready',
]);

export const paymentProvider = pgEnum('payment_provider', ['stripe', 'offline', 'gocardless']);

export const paymentStatus = pgEnum('payment_status', [
  'requires_action',
  'pending',
  'succeeded',
  'failed',
  'refunded',
  'partially_refunded',
]);

export const planType = pgEnum('plan_type', [
  'prepay_credits',
  'seat_licence',
  'flat_access',
  'postpay',
]);

export const ledgerEntryType = pgEnum('ledger_entry_type', [
  'purchase',
  'usage',
  'adjustment',
  'expiry',
  'refund',
]);

export const reportModel = pgEnum('report_model', ['individual', 'aggregate', 'both']);

/**
 * Response-store status (A4 re-scope: Neon jsonb replaces Firestore). A
 * response is `draft` while in progress and becomes `submitted` exactly once;
 * answers are immutable after submit.
 */
export const responseStatus = pgEnum('response_status', ['draft', 'submitted']);

export const scoringMode = pgEnum('scoring_mode', ['sync_internal', 'async_external']);

export const royaltyMethod = pgEnum('royalty_method', [
  'pct_net_revenue',
  'fixed_per_completion',
  'hybrid',
]);

export const settlementMethod = pgEnum('settlement_method', [
  'stripe_connect',
  'platform_invoice',
  'manual',
]);

export const domainStatus = pgEnum('domain_status', [
  'pending_dns',
  'verifying',
  'active',
  'failed',
  'disabled',
]);

export const roleName = pgEnum('role_name', [
  'super_admin',
  'assessment_admin',
  'client_admin',
  'client_user',
  'assessment_taker',
]);
