import { z } from 'zod';

/**
 * Payment domain vocabulary + service-input schemas (D3 — spec 06 "Payments
 * (Payment Module)", spec 04 `payments` table). Assessment-agnostic; all
 * money is integer minor units. The enum values mirror the normative
 * Postgres enums in `packages/db/src/schema/enums.ts` — do not reorder.
 */

// ---------------------------------------------------------------------------
// Vocabulary (mirrors db enums — normative)
// ---------------------------------------------------------------------------

export const paymentProviders = ['stripe', 'offline', 'gocardless'] as const;
export const paymentProviderSchema = z.enum(paymentProviders);
export type PaymentProvider = z.infer<typeof paymentProviderSchema>;

/** `payments.method` (spec 04): card | us_bank_account | offline. */
export const paymentMethods = ['card', 'us_bank_account', 'offline'] as const;
export const paymentMethodSchema = z.enum(paymentMethods);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const paymentStatuses = [
  'requires_action',
  'pending',
  'succeeded',
  'failed',
  'refunded',
  'partially_refunded',
] as const;
export const paymentStatusSchema = z.enum(paymentStatuses);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/**
 * Statuses a payment may still move to `succeeded`/`failed` from. `failed`
 * is included for success: Stripe allows re-confirming the same intent after
 * a decline, so a late `payment_intent.succeeded` legitimately follows a
 * failure event.
 */
export const OPEN_PAYMENT_STATUSES = [
  'requires_action',
  'pending',
  'failed',
] as const satisfies readonly PaymentStatus[];

// ---------------------------------------------------------------------------
// Entity (one `payments` row, mapped to the domain)
// ---------------------------------------------------------------------------

const currencyCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code, e.g. EUR');

export const paymentSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid().nullable(),
  invoiceId: z.string().uuid().nullable(),
  provider: paymentProviderSchema,
  /** Stripe PaymentIntent id etc. — webhook correlation key (spec 06 idempotency). */
  providerRef: z.string().nullable(),
  method: paymentMethodSchema.nullable(),
  status: paymentStatusSchema,
  /** Integer minor units (cents). */
  amount: z.number().int().nonnegative(),
  currency: currencyCodeSchema,
  /** Structured failure context — provider codes and event ids only, never PII. */
  error: z.record(z.unknown()).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Payment = z.infer<typeof paymentSchema>;

// ---------------------------------------------------------------------------
// Service inputs
// ---------------------------------------------------------------------------

/**
 * Initiate the payment step for an order (wizard step 4, spec 06). Phase 1
 * supports card (Stripe) and offline (invoice); `us_bank_account` (ACH) and
 * entitlement draw-down land with their own epics.
 */
export const initiatePaymentSchema = z
  .object({
    orderId: z.string().uuid(),
    method: z.enum(['card', 'offline']),
  })
  .strict();
export type InitiatePaymentInput = z.input<typeof initiatePaymentSchema>;
export type InitiatePayment = z.output<typeof initiatePaymentSchema>;

/** Admin refund request (spec 06: order moves to `refunded` only after the provider refund succeeds). */
export const refundPaymentSchema = z
  .object({
    paymentId: z.string().uuid(),
    /** Partial refund in integer minor units; omit for a full refund. */
    amountMinor: z.number().int().positive().optional(),
  })
  .strict();
export type RefundPaymentInput = z.input<typeof refundPaymentSchema>;
export type RefundPayment = z.output<typeof refundPaymentSchema>;
