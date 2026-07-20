/**
 * Payment adapter contract (docs/spec/06-orders-and-state-machine.md
 * "Payments (Payment Module)", appendix-architecture-layers.md §4).
 *
 * The adapter only knows *how* to execute charges — the payment SERVICE
 * decides *what* to charge and how outcomes drive order transitions.
 * Inbound webhooks go API Route → Adapter (verify signature FIRST, then
 * parse) → Service (handle). Providers (Stripe, offline, memory) live in
 * ./providers/ and are wired at composition roots; services import these
 * types only (enforced by .dependency-cruiser.cjs).
 */
import type { PaymentProvider } from '@assessify/domain';

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/** Charge methods the adapter interface knows (spec 06). ACH is phase 2. */
export type PaymentIntentMethod = 'card' | 'us_bank_account' | 'offline';

export interface PaymentIntentInput {
  /** Integer minor units (cents) — the order's snapshot total. */
  amountMinor: number;
  /** ISO 4217 uppercase, e.g. 'EUR'. */
  currency: string;
  method: PaymentIntentMethod;
  /** Provider customer id (saved cards) — optional in phase 1. */
  customerRef?: string;
  /** Correlation ids attached to the provider object. Ids only — never PII. */
  metadata: { orderId: string };
}

/**
 * Normalised intent status. `requires_action` covers every provider state
 * that still needs a client-side step (Stripe requires_payment_method /
 * requires_confirmation / requires_action / requires_capture); `pending`
 * means the provider is processing (or, for offline, awaiting manual
 * reconciliation).
 */
export type PaymentIntentStatus = 'requires_action' | 'pending' | 'succeeded' | 'failed';

export interface PaymentIntentResult {
  provider: PaymentProvider;
  /** Provider intent id (Stripe `pi_…`) — stored as `payments.provider_ref`. */
  providerRef: string;
  status: PaymentIntentStatus;
  /** Client-side confirmation secret (Stripe `client_secret`); null when not applicable (offline). */
  clientSecret: string | null;
}

/** Point-in-time provider view of an intent (retrieve/confirm status). */
export interface PaymentIntentSnapshot {
  providerRef: string;
  status: PaymentIntentStatus;
  /** Null when the provider does not track it (offline). */
  amountMinor: number | null;
  currency: string | null;
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export type RefundStatus = 'pending' | 'succeeded' | 'failed';

export interface RefundResult {
  provider: PaymentProvider;
  /** Provider refund id (Stripe `re_…`). */
  refundRef: string;
  status: RefundStatus;
  amountMinor: number | null;
}

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------

/**
 * Normalised inbound provider event. `checkout_completed` (retail Stripe
 * Checkout, G1) and `unhandled` are parsed but acknowledged without action
 * so the provider stops redelivering them.
 */
export type PaymentEventType =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'refund_completed'
  | 'checkout_completed'
  | 'unhandled';

export interface PaymentEvent {
  /** Provider event id (Stripe `evt_…`) — recorded in the audit trail for dedupe forensics. */
  eventId: string;
  type: PaymentEventType;
  provider: PaymentProvider;
  /** Provider intent id — matches `payments.provider_ref` (spec 06 idempotency key). */
  providerRef: string | null;
  /** `metadata.orderId` echoed back by the provider, if present. */
  orderId: string | null;
  amountMinor: number | null;
  currency: string | null;
  occurredAt: Date | null;
  /** Failure context for `payment_failed` — provider codes only, never PII. */
  failure?: { code: string | null };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface PaymentAdapter {
  readonly provider: PaymentProvider;
  /** Create a provider intent for the given amount. Rejects with {@link PaymentAdapterError}. */
  createIntent(input: PaymentIntentInput): Promise<PaymentIntentResult>;
  /** Retrieve the provider's current view of an intent. */
  getIntent(providerRef: string): Promise<PaymentIntentSnapshot>;
  /** Refund an intent, fully (no amount) or partially (integer minor units). */
  refund(providerRef: string, amountMinor?: number): Promise<RefundResult>;
  /**
   * Verify the webhook signature FIRST, then parse the payload into a
   * normalised event. Throws {@link PaymentWebhookSignatureError} (→ 401) or
   * {@link PaymentWebhookPayloadError} (→ 400).
   */
  parseWebhook(rawBody: string, signature: string): Promise<PaymentEvent>;
}

// ---------------------------------------------------------------------------
// Errors (never contain PII)
// ---------------------------------------------------------------------------

/** Thrown by payment providers when a provider call fails. */
export class PaymentAdapterError extends Error {
  constructor(
    message: string,
    /** HTTP status returned by the provider, if any. */
    readonly status?: number,
    /** True when retrying can never succeed (rejected payload, auth failure). */
    readonly permanent: boolean = false
  ) {
    super(message);
    this.name = 'PaymentAdapterError';
  }
}

/** Webhook signature verification failed — the route replies 401. */
export class PaymentWebhookSignatureError extends Error {
  constructor(message = 'webhook signature verification failed') {
    super(message);
    this.name = 'PaymentWebhookSignatureError';
  }
}

/** The (already signature-verified) payload is malformed — the route replies 400. */
export class PaymentWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentWebhookPayloadError';
  }
}
