import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  PaymentAdapterError,
  PaymentWebhookPayloadError,
  PaymentWebhookSignatureError,
} from '../types';
import {
  createStripePaymentAdapter,
  parseStripeEvent,
  verifyStripeWebhookSignature,
} from './stripe';

const ORDER_ID = '01890000-0000-7000-8000-000000000042';
const SECRET = 'whsec_test_secret_for_d3';

/** Sign a payload exactly the way Stripe does: HMAC-SHA256 over `t.body`. */
function sign(payload: string, timestampSeconds: number, secret = SECRET): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${payload}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}

const NOW = new Date('2026-07-20T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('verifyStripeWebhookSignature', () => {
  const base = { secret: SECRET, now: () => NOW };

  it('accepts a correctly signed payload inside the tolerance window', () => {
    const payload = '{"id":"evt_1"}';
    expect(
      verifyStripeWebhookSignature({
        ...base,
        payload,
        signatureHeader: sign(payload, NOW_SECONDS - 30),
      })
    ).toBe(true);
  });

  it('accepts when any one v1 signature matches (key rotation)', () => {
    const payload = '{"id":"evt_1"}';
    const good = sign(payload, NOW_SECONDS);
    expect(
      verifyStripeWebhookSignature({
        ...base,
        payload,
        signatureHeader: `${good},v1=${'0'.repeat(64)}`,
      })
    ).toBe(true);
  });

  it('rejects a tampered payload', () => {
    expect(
      verifyStripeWebhookSignature({
        ...base,
        payload: '{"id":"evt_TAMPERED"}',
        signatureHeader: sign('{"id":"evt_1"}', NOW_SECONDS),
      })
    ).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const payload = '{"id":"evt_1"}';
    expect(
      verifyStripeWebhookSignature({
        ...base,
        payload,
        signatureHeader: sign(payload, NOW_SECONDS, 'whsec_other'),
      })
    ).toBe(false);
  });

  it('rejects timestamps outside the tolerance window (replay protection)', () => {
    const payload = '{"id":"evt_1"}';
    expect(
      verifyStripeWebhookSignature({
        ...base,
        payload,
        signatureHeader: sign(payload, NOW_SECONDS - 301),
      })
    ).toBe(false);
    expect(
      verifyStripeWebhookSignature({
        ...base,
        payload,
        signatureHeader: sign(payload, NOW_SECONDS - 301),
        toleranceSeconds: 600,
      })
    ).toBe(true);
  });

  it('rejects malformed headers without throwing', () => {
    for (const header of ['', 'nonsense', 't=abc,v1=00', `t=${NOW_SECONDS}`, 'v1=00']) {
      expect(
        verifyStripeWebhookSignature({ ...base, payload: '{}', signatureHeader: header })
      ).toBe(false);
    }
  });
});

describe('parseStripeEvent', () => {
  function envelope(type: string, object: Record<string, unknown>): unknown {
    return {
      id: 'evt_123',
      object: 'event',
      type,
      created: NOW_SECONDS,
      data: { object },
    };
  }

  it('maps payment_intent.succeeded with metadata and amount_received', () => {
    const event = parseStripeEvent(
      envelope('payment_intent.succeeded', {
        id: 'pi_1',
        amount: 12_500,
        amount_received: 12_500,
        currency: 'eur',
        metadata: { orderId: ORDER_ID },
      })
    );
    expect(event).toMatchObject({
      eventId: 'evt_123',
      type: 'payment_succeeded',
      provider: 'stripe',
      providerRef: 'pi_1',
      orderId: ORDER_ID,
      amountMinor: 12_500,
      currency: 'EUR',
    });
    expect(event.occurredAt).toEqual(new Date(NOW_SECONDS * 1000));
  });

  it('maps payment_intent.payment_failed with the decline code only (no PII)', () => {
    const event = parseStripeEvent(
      envelope('payment_intent.payment_failed', {
        id: 'pi_1',
        amount: 12_500,
        currency: 'eur',
        metadata: { orderId: ORDER_ID },
        last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
      })
    );
    expect(event.type).toBe('payment_failed');
    expect(event.failure).toEqual({ code: 'card_declined' });
    expect(JSON.stringify(event)).not.toContain('Your card was declined');
  });

  it('maps charge.refunded onto the parent payment intent with the refunded amount', () => {
    const event = parseStripeEvent(
      envelope('charge.refunded', {
        id: 'ch_1',
        payment_intent: 'pi_1',
        amount: 12_500,
        amount_refunded: 2_500,
        currency: 'eur',
      })
    );
    expect(event).toMatchObject({
      type: 'refund_completed',
      providerRef: 'pi_1',
      amountMinor: 2_500,
    });
  });

  it('maps checkout.session.completed and unknown types without failing', () => {
    expect(
      parseStripeEvent(
        envelope('checkout.session.completed', { id: 'cs_1', payment_intent: 'pi_9' })
      )
    ).toMatchObject({ type: 'checkout_completed', providerRef: 'pi_9' });
    expect(parseStripeEvent(envelope('customer.created', { id: 'cus_1' }))).toMatchObject({
      type: 'unhandled',
    });
  });

  it('throws PaymentWebhookPayloadError for non-event bodies', () => {
    for (const body of [null, [], 'x', { id: 'evt_1' }, { object: 'event' }]) {
      expect(() => parseStripeEvent(body)).toThrow(PaymentWebhookPayloadError);
    }
  });
});

describe('stripe payment adapter (REST over fetch)', () => {
  function adapterWith(fetchImpl: typeof fetch) {
    return createStripePaymentAdapter({
      secretKey: 'sk_test_123',
      webhookSecret: SECRET,
      fetchImpl,
      now: () => NOW,
    });
  }

  it('createIntent posts a form-encoded PaymentIntent with an orderId-derived idempotency key', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 'pi_1', status: 'requires_payment_method', client_secret: 'pi_1_secret' })
    );
    const adapter = adapterWith(fetchImpl as unknown as typeof fetch);

    const result = await adapter.createIntent({
      amountMinor: 12_500,
      currency: 'EUR',
      method: 'card',
      metadata: { orderId: ORDER_ID },
    });

    expect(result).toEqual({
      provider: 'stripe',
      providerRef: 'pi_1',
      status: 'requires_action',
      clientSecret: 'pi_1_secret',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk_test_123');
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers['idempotency-key']).toBe(`assessify:pi:${ORDER_ID}`);
    const body = new URLSearchParams(init.body as string);
    expect(body.get('amount')).toBe('12500');
    expect(body.get('currency')).toBe('eur');
    expect(body.get('payment_method_types[]')).toBe('card');
    expect(body.get('metadata[orderId]')).toBe(ORDER_ID);
  });

  it('createIntent refuses the offline method', async () => {
    const adapter = adapterWith(vi.fn() as unknown as typeof fetch);
    await expect(
      adapter.createIntent({
        amountMinor: 1,
        currency: 'EUR',
        method: 'offline',
        metadata: { orderId: ORDER_ID },
      })
    ).rejects.toBeInstanceOf(PaymentAdapterError);
  });

  it('maps provider errors: 402 is permanent, 500 is retryable, without echoing secrets', async () => {
    const declined = adapterWith(
      vi.fn(async () =>
        jsonResponse({ error: { code: 'card_declined', message: 'declined' } }, 402)
      ) as unknown as typeof fetch
    );
    await expect(declined.getIntent('pi_1')).rejects.toMatchObject({
      name: 'PaymentAdapterError',
      status: 402,
      permanent: true,
    });

    const flaky = adapterWith(
      vi.fn(async () => jsonResponse({ error: { message: 'boom' } }, 500)) as unknown as typeof fetch
    );
    await expect(flaky.getIntent('pi_1')).rejects.toMatchObject({ status: 500, permanent: false });
  });

  it('getIntent normalises the provider status', async () => {
    const adapter = adapterWith(
      vi.fn(async () =>
        jsonResponse({ id: 'pi_1', status: 'succeeded', amount: 12_500, currency: 'eur' })
      ) as unknown as typeof fetch
    );
    await expect(adapter.getIntent('pi_1')).resolves.toEqual({
      providerRef: 'pi_1',
      status: 'succeeded',
      amountMinor: 12_500,
      currency: 'EUR',
    });
  });

  it('refund posts against the payment intent with its own idempotency key', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: 're_1', status: 'succeeded', amount: 2_500 })
    );
    const adapter = adapterWith(fetchImpl as unknown as typeof fetch);

    await expect(adapter.refund('pi_1', 2_500)).resolves.toEqual({
      provider: 'stripe',
      refundRef: 're_1',
      status: 'succeeded',
      amountMinor: 2_500,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/refunds');
    const headers = init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('assessify:refund:pi_1:2500');
    expect(new URLSearchParams(init.body as string).get('payment_intent')).toBe('pi_1');
  });

  it('parseWebhook verifies the signature first, then parses', async () => {
    const adapter = adapterWith(vi.fn() as unknown as typeof fetch);
    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'payment_intent.succeeded',
      created: NOW_SECONDS,
      data: { object: { id: 'pi_1', amount: 100, currency: 'eur' } },
    });

    await expect(
      adapter.parseWebhook(payload, sign(payload, NOW_SECONDS))
    ).resolves.toMatchObject({ eventId: 'evt_1', type: 'payment_succeeded', providerRef: 'pi_1' });

    await expect(
      adapter.parseWebhook(payload, sign(payload, NOW_SECONDS, 'whsec_wrong'))
    ).rejects.toBeInstanceOf(PaymentWebhookSignatureError);

    const garbage = 'not json';
    await expect(
      adapter.parseWebhook(garbage, sign(garbage, NOW_SECONDS))
    ).rejects.toBeInstanceOf(PaymentWebhookPayloadError);
  });
});
