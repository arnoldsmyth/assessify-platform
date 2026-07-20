/**
 * Stripe payment provider (docs/spec/06-orders-and-state-machine.md: card,
 * immediate capture, phase 1).
 *
 * Talks straight to the Stripe REST API over fetch — no `stripe` SDK
 * dependency (the SDK pulls in its own HTTP stack and types we do not need;
 * the three calls used here are stable, form-encoded endpoints). Every
 * mutating call sends an Idempotency-Key derived from the order id
 * (spec 06: "All Stripe calls send idempotency keys derived from orderId").
 *
 * Webhooks: Stripe signs `t.<rawBody>` with HMAC-SHA256 and sends
 * `Stripe-Signature: t=<ts>,v1=<hex>[,v1=…]`. Verification is constant-time
 * and enforces a replay-tolerance window BEFORE the payload is parsed.
 *
 * Concrete provider — wired at composition roots only; services see the
 * PaymentAdapter interface (enforced by .dependency-cruiser.cjs).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import {
  PaymentAdapterError,
  PaymentWebhookPayloadError,
  PaymentWebhookSignatureError,
  type PaymentAdapter,
  type PaymentEvent,
  type PaymentEventType,
  type PaymentIntentResult,
  type PaymentIntentSnapshot,
  type PaymentIntentStatus,
  type RefundResult,
  type RefundStatus,
} from '../types';

export const STRIPE_API_BASE_URL = 'https://api.stripe.com';
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
/** Default replay-tolerance window (seconds) — Stripe's own recommendation. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export interface VerifyStripeSignatureInput {
  /** Webhook signing secret (`whsec_…`) — from env at the composition root. */
  secret: string;
  /** Raw request body, byte-for-byte as received. */
  payload: string;
  /** Full `Stripe-Signature` header value (`t=…,v1=…`). */
  signatureHeader: string;
  /** Max clock skew in seconds (default {@link STRIPE_SIGNATURE_TOLERANCE_SECONDS}). */
  toleranceSeconds?: number;
  /** Override for tests. */
  now?: () => Date;
}

/**
 * Verify a Stripe webhook signature. Returns false (never throws) on any
 * malformed header, stale timestamp, or mismatch so the route can reply 401
 * uniformly. Comparison is constant-time (`timingSafeEqual`).
 */
export function verifyStripeWebhookSignature(input: VerifyStripeSignatureInput): boolean {
  try {
    let timestamp: string | null = null;
    const signatures: string[] = [];
    for (const part of input.signatureHeader.split(',')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key === 't') timestamp = value;
      else if (key === 'v1') signatures.push(value);
    }
    if (timestamp === null || signatures.length === 0) return false;

    const timestampSeconds = Number(timestamp);
    if (!Number.isInteger(timestampSeconds)) return false;
    const tolerance = input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
    const nowSeconds = Math.floor((input.now?.() ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > tolerance) return false;

    const expected = createHmac('sha256', input.secret)
      .update(`${timestamp}.${input.payload}`, 'utf8')
      .digest();
    return signatures.some((signature) => {
      const candidate = Buffer.from(signature, 'hex');
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

/** Stripe event types → normalised PaymentEventType. Everything else is `unhandled`. */
const EVENT_TYPES: Record<string, PaymentEventType> = {
  'payment_intent.succeeded': 'payment_succeeded',
  'payment_intent.payment_failed': 'payment_failed',
  'charge.refunded': 'refund_completed',
  'checkout.session.completed': 'checkout_completed',
};

/**
 * The slice of `event.data.object` we read. `.passthrough()` because Stripe
 * objects carry many fields (some, like `charges.data[].billing_details`,
 * are PII) — nothing beyond this shape is ever extracted or persisted.
 */
const stripeObjectSchema = z
  .object({
    id: z.string(),
    /** amount_received on PaymentIntents; amount_refunded on Charges. */
    amount: z.number().int().optional(),
    amount_received: z.number().int().optional(),
    amount_refunded: z.number().int().optional(),
    currency: z.string().optional(),
    /** Set on Charge / Checkout Session objects. */
    payment_intent: z.string().nullable().optional(),
    metadata: z.record(z.string()).nullish(),
    last_payment_error: z.object({ code: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();

const stripeEventSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal('event'),
    type: z.string(),
    created: z.number().int().optional(),
    data: z.object({ object: stripeObjectSchema }),
  })
  .passthrough();

/**
 * Parse a signature-verified webhook body into a normalised PaymentEvent.
 * Unknown event types come back as `unhandled` (the route acks them so
 * Stripe stops redelivering); a body that is not a Stripe event envelope at
 * all throws {@link PaymentWebhookPayloadError} → respond 400.
 */
export function parseStripeEvent(body: unknown): PaymentEvent {
  const parsed = stripeEventSchema.safeParse(body);
  if (!parsed.success) {
    throw new PaymentWebhookPayloadError('webhook payload is not a Stripe event');
  }
  const event = parsed.data;
  const type = EVENT_TYPES[event.type] ?? 'unhandled';
  const object = event.data.object;

  // PaymentIntent events carry the intent id itself; Charge / Checkout
  // Session events reference it via `payment_intent`.
  const providerRef = event.type.startsWith('payment_intent.')
    ? object.id
    : (object.payment_intent ?? null);

  let amountMinor: number | null = null;
  if (type === 'refund_completed') amountMinor = object.amount_refunded ?? null;
  else amountMinor = object.amount_received ?? object.amount ?? null;

  const result: PaymentEvent = {
    eventId: event.id,
    type,
    provider: 'stripe',
    providerRef,
    orderId: object.metadata?.['orderId'] ?? null,
    amountMinor,
    currency: object.currency?.toUpperCase() ?? null,
    occurredAt: event.created !== undefined ? new Date(event.created * 1000) : null,
  };
  if (type === 'payment_failed') {
    result.failure = { code: object.last_payment_error?.code ?? null };
  }
  return result;
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export interface StripePaymentAdapterOptions {
  /** Stripe secret key (`sk_…`) — from env at the composition root, never hardcoded. */
  secretKey: string;
  /** Webhook signing secret (`whsec_…`) — required only for parseWebhook. */
  webhookSecret?: string;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override for tests. */
  baseUrl?: string;
  toleranceSeconds?: number;
  now?: () => Date;
}

/** Stripe PaymentIntent statuses → normalised PaymentIntentStatus. */
const INTENT_STATUS: Record<string, PaymentIntentStatus> = {
  requires_payment_method: 'requires_action',
  requires_confirmation: 'requires_action',
  requires_action: 'requires_action',
  requires_capture: 'requires_action',
  processing: 'pending',
  succeeded: 'succeeded',
  canceled: 'failed',
};

const REFUND_STATUS: Record<string, RefundStatus> = {
  pending: 'pending',
  requires_action: 'pending',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'failed',
};

const paymentIntentResponseSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    client_secret: z.string().nullish(),
    amount: z.number().int().optional(),
    currency: z.string().optional(),
  })
  .passthrough();

const refundResponseSchema = z
  .object({
    id: z.string(),
    status: z.string().nullish(),
    amount: z.number().int().optional(),
  })
  .passthrough();

/** Extract Stripe's error message without echoing request values (no PII). */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
      const error = (parsed as { error: unknown }).error;
      if (error !== null && typeof error === 'object') {
        const code = 'code' in error ? String((error as { code: unknown }).code) : '';
        const message = 'message' in error ? String((error as { message: unknown }).message) : '';
        const detail = [code, message].filter((s) => s && s !== 'undefined').join(': ');
        if (detail) return detail.slice(0, 300);
      }
    }
  } catch {
    // Non-JSON error body — fall through to the generic detail.
  }
  return 'no error detail';
}

export function createStripePaymentAdapter(options: StripePaymentAdapterOptions): PaymentAdapter {
  const {
    secretKey,
    webhookSecret,
    fetchImpl = fetch,
    baseUrl = STRIPE_API_BASE_URL,
    toleranceSeconds,
    now,
  } = options;

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, string>,
    idempotencyKey?: string
  ): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` };
    let encodedBody: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      encodedBody = new URLSearchParams(body).toString();
    }
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: encodedBody });
    } catch (cause) {
      throw new PaymentAdapterError(
        `stripe request failed: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      // 4xx (except 408/429) can never succeed on retry; 5xx/429 are transient.
      const permanent =
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429;
      throw new PaymentAdapterError(
        `stripe rejected the call (${response.status}): ${detail}`,
        response.status,
        permanent
      );
    }
    return response.json();
  }

  return {
    provider: 'stripe',

    async createIntent(input): Promise<PaymentIntentResult> {
      if (input.method === 'offline') {
        throw new PaymentAdapterError(
          'the stripe provider does not record offline payments',
          undefined,
          true
        );
      }
      const body: Record<string, string> = {
        amount: String(input.amountMinor),
        currency: input.currency.toLowerCase(),
        'payment_method_types[]': input.method,
        'metadata[orderId]': input.metadata.orderId,
      };
      if (input.customerRef !== undefined) body['customer'] = input.customerRef;

      const raw = await request(
        'POST',
        '/v1/payment_intents',
        body,
        `assessify:pi:${input.metadata.orderId}`
      );
      const intent = paymentIntentResponseSchema.safeParse(raw);
      if (!intent.success) {
        throw new PaymentAdapterError('stripe returned an unexpected payment_intent shape', undefined, true);
      }
      return {
        provider: 'stripe',
        providerRef: intent.data.id,
        status: INTENT_STATUS[intent.data.status] ?? 'pending',
        clientSecret: intent.data.client_secret ?? null,
      };
    },

    async getIntent(providerRef): Promise<PaymentIntentSnapshot> {
      const raw = await request('GET', `/v1/payment_intents/${encodeURIComponent(providerRef)}`);
      const intent = paymentIntentResponseSchema.safeParse(raw);
      if (!intent.success) {
        throw new PaymentAdapterError('stripe returned an unexpected payment_intent shape', undefined, true);
      }
      return {
        providerRef: intent.data.id,
        status: INTENT_STATUS[intent.data.status] ?? 'pending',
        amountMinor: intent.data.amount ?? null,
        currency: intent.data.currency?.toUpperCase() ?? null,
      };
    },

    async refund(providerRef, amountMinor): Promise<RefundResult> {
      const body: Record<string, string> = { payment_intent: providerRef };
      if (amountMinor !== undefined) body['amount'] = String(amountMinor);
      const raw = await request(
        'POST',
        '/v1/refunds',
        body,
        `assessify:refund:${providerRef}:${amountMinor ?? 'full'}`
      );
      const refund = refundResponseSchema.safeParse(raw);
      if (!refund.success) {
        throw new PaymentAdapterError('stripe returned an unexpected refund shape', undefined, true);
      }
      return {
        provider: 'stripe',
        refundRef: refund.data.id,
        status: REFUND_STATUS[refund.data.status ?? 'pending'] ?? 'pending',
        amountMinor: refund.data.amount ?? null,
      };
    },

    async parseWebhook(rawBody, signature): Promise<PaymentEvent> {
      if (!webhookSecret) {
        throw new PaymentAdapterError(
          'stripe adapter was created without a webhook secret',
          undefined,
          true
        );
      }
      const verifyInput: VerifyStripeSignatureInput = {
        secret: webhookSecret,
        payload: rawBody,
        signatureHeader: signature,
      };
      if (toleranceSeconds !== undefined) verifyInput.toleranceSeconds = toleranceSeconds;
      if (now !== undefined) verifyInput.now = now;
      if (!verifyStripeWebhookSignature(verifyInput)) {
        throw new PaymentWebhookSignatureError();
      }
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new PaymentWebhookPayloadError('webhook payload is not valid JSON');
      }
      return parseStripeEvent(body);
    },
  };
}
