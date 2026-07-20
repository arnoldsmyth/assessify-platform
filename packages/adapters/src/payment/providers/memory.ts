/**
 * In-memory payment provider for tests: records intents instead of charging,
 * returns deterministic refs (`mem_pi_1`, …), lets tests flip intent status
 * and force failures, and can mint normalised PaymentEvents for a recorded
 * intent (to drive service webhook tests without real signatures). This is
 * the reference implementation of the PaymentAdapter contract — the adapter
 * contract test runs against it.
 *
 * parseWebhook accepts a JSON-encoded {@link PaymentEvent} as the raw body
 * and requires the signature to equal the configured `webhookSignature`, so
 * the 401/400 route branches are exercisable without HMAC plumbing.
 */
import type { PaymentProvider } from '@assessify/domain';

import {
  PaymentAdapterError,
  PaymentWebhookPayloadError,
  PaymentWebhookSignatureError,
  type PaymentAdapter,
  type PaymentEvent,
  type PaymentEventType,
  type PaymentIntentInput,
  type PaymentIntentResult,
  type PaymentIntentStatus,
  type RefundResult,
} from '../types';

export interface MemoryPaymentIntent {
  providerRef: string;
  status: PaymentIntentStatus;
  amountMinor: number;
  currency: string;
  method: PaymentIntentInput['method'];
  orderId: string;
  clientSecret: string | null;
  refundedMinor: number;
}

export interface MemoryPaymentAdapterOptions {
  /** Provider identity reported on results (default 'stripe'). */
  provider?: PaymentProvider;
  /** Signature parseWebhook demands (default 'memory-signature'). */
  webhookSignature?: string;
  /** Status newly created intents report (default 'requires_action'). */
  initialStatus?: PaymentIntentStatus;
}

export interface MemoryPaymentAdapter extends PaymentAdapter {
  /** Every intent created, in order. */
  readonly intents: readonly MemoryPaymentIntent[];
  /** Flip a recorded intent's status (simulates provider-side progress). */
  setIntentStatus(providerRef: string, status: PaymentIntentStatus): void;
  /** Make subsequent calls reject with the given error (null to reset). */
  failWith(error: PaymentAdapterError | null): void;
  /** Build a normalised event for a recorded intent (service webhook tests). */
  eventFor(providerRef: string, type: PaymentEventType, eventId?: string): PaymentEvent;
  /** Forget recorded intents and reset counters. */
  reset(): void;
}

export function createMemoryPaymentAdapter(
  options: MemoryPaymentAdapterOptions = {}
): MemoryPaymentAdapter {
  const {
    provider = 'stripe',
    webhookSignature = 'memory-signature',
    initialStatus = 'requires_action',
  } = options;
  const intents: MemoryPaymentIntent[] = [];
  let failure: PaymentAdapterError | null = null;
  let counter = 0;
  let eventCounter = 0;

  function find(providerRef: string): MemoryPaymentIntent {
    const intent = intents.find((i) => i.providerRef === providerRef);
    if (!intent) {
      throw new PaymentAdapterError(`no such intent: ${providerRef}`, 404, true);
    }
    return intent;
  }

  return {
    provider,
    intents,

    setIntentStatus(providerRef, status) {
      find(providerRef).status = status;
    },

    failWith(error) {
      failure = error;
    },

    eventFor(providerRef, type, eventId) {
      const intent = find(providerRef);
      eventCounter += 1;
      const event: PaymentEvent = {
        eventId: eventId ?? `mem_evt_${eventCounter}`,
        type,
        provider,
        providerRef: intent.providerRef,
        orderId: intent.orderId,
        amountMinor:
          type === 'refund_completed' ? intent.refundedMinor || intent.amountMinor : intent.amountMinor,
        currency: intent.currency,
        occurredAt: new Date(),
      };
      if (type === 'payment_failed') event.failure = { code: 'card_declined' };
      return event;
    },

    reset() {
      intents.length = 0;
      failure = null;
      counter = 0;
      eventCounter = 0;
    },

    async createIntent(input): Promise<PaymentIntentResult> {
      if (failure) throw failure;
      counter += 1;
      const intent: MemoryPaymentIntent = {
        providerRef: `mem_pi_${counter}`,
        status: input.method === 'offline' ? 'pending' : initialStatus,
        amountMinor: input.amountMinor,
        currency: input.currency,
        method: input.method,
        orderId: input.metadata.orderId,
        clientSecret: input.method === 'offline' ? null : `mem_secret_${counter}`,
        refundedMinor: 0,
      };
      intents.push(intent);
      return {
        provider,
        providerRef: intent.providerRef,
        status: intent.status,
        clientSecret: intent.clientSecret,
      };
    },

    async getIntent(providerRef) {
      if (failure) throw failure;
      const intent = find(providerRef);
      return {
        providerRef: intent.providerRef,
        status: intent.status,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
      };
    },

    async refund(providerRef, amountMinor): Promise<RefundResult> {
      if (failure) throw failure;
      const intent = find(providerRef);
      if (intent.status !== 'succeeded') {
        throw new PaymentAdapterError('only succeeded intents can be refunded', 400, true);
      }
      const amount = amountMinor ?? intent.amountMinor - intent.refundedMinor;
      if (amount <= 0 || intent.refundedMinor + amount > intent.amountMinor) {
        throw new PaymentAdapterError('refund exceeds the refundable amount', 400, true);
      }
      intent.refundedMinor += amount;
      counter += 1;
      return { provider, refundRef: `mem_re_${counter}`, status: 'succeeded', amountMinor: amount };
    },

    async parseWebhook(rawBody, signature): Promise<PaymentEvent> {
      if (signature !== webhookSignature) throw new PaymentWebhookSignatureError();
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        throw new PaymentWebhookPayloadError('webhook payload is not valid JSON');
      }
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        typeof (parsed as { eventId?: unknown }).eventId !== 'string' ||
        typeof (parsed as { type?: unknown }).type !== 'string'
      ) {
        throw new PaymentWebhookPayloadError('webhook payload is not a payment event');
      }
      const event = parsed as PaymentEvent & { occurredAt: string | Date | null };
      return {
        ...event,
        occurredAt:
          typeof event.occurredAt === 'string' ? new Date(event.occurredAt) : event.occurredAt,
      };
    },
  };
}
