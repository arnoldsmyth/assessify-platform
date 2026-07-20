import { describe, expect, it } from 'vitest';

import {
  PaymentAdapterError,
  PaymentWebhookPayloadError,
  PaymentWebhookSignatureError,
  type PaymentIntentInput,
} from '../types';
import { createMemoryPaymentAdapter } from './memory';
import { createOfflinePaymentAdapter } from './offline';

const ORDER_ID = '01890000-0000-7000-8000-000000000042';

function cardIntent(overrides: Partial<PaymentIntentInput> = {}): PaymentIntentInput {
  return {
    amountMinor: 12_500,
    currency: 'EUR',
    method: 'card',
    metadata: { orderId: ORDER_ID },
    ...overrides,
  };
}

/** Contract tests against the reference (memory) provider. */
describe('memory payment adapter', () => {
  it('creates intents with deterministic refs, a client secret, and the order metadata', async () => {
    const adapter = createMemoryPaymentAdapter();
    const result = await adapter.createIntent(cardIntent());

    expect(result).toEqual({
      provider: 'stripe',
      providerRef: 'mem_pi_1',
      status: 'requires_action',
      clientSecret: 'mem_secret_1',
    });
    expect(adapter.intents[0]).toMatchObject({
      amountMinor: 12_500,
      currency: 'EUR',
      orderId: ORDER_ID,
    });
  });

  it('reflects provider-side status changes through getIntent', async () => {
    const adapter = createMemoryPaymentAdapter();
    const { providerRef } = await adapter.createIntent(cardIntent());

    adapter.setIntentStatus(providerRef, 'succeeded');
    await expect(adapter.getIntent(providerRef)).resolves.toEqual({
      providerRef,
      status: 'succeeded',
      amountMinor: 12_500,
      currency: 'EUR',
    });
  });

  it('refunds succeeded intents fully and partially, and rejects over-refunds', async () => {
    const adapter = createMemoryPaymentAdapter();
    const { providerRef } = await adapter.createIntent(cardIntent());
    adapter.setIntentStatus(providerRef, 'succeeded');

    const partial = await adapter.refund(providerRef, 2_500);
    expect(partial.status).toBe('succeeded');
    expect(partial.amountMinor).toBe(2_500);

    const rest = await adapter.refund(providerRef);
    expect(rest.amountMinor).toBe(10_000);

    await expect(adapter.refund(providerRef, 1)).rejects.toBeInstanceOf(PaymentAdapterError);
  });

  it('rejects refunds of unsettled intents', async () => {
    const adapter = createMemoryPaymentAdapter();
    const { providerRef } = await adapter.createIntent(cardIntent());
    await expect(adapter.refund(providerRef)).rejects.toBeInstanceOf(PaymentAdapterError);
  });

  it('parseWebhook rejects a wrong signature before reading the payload', async () => {
    const adapter = createMemoryPaymentAdapter();
    await expect(adapter.parseWebhook('{}', 'wrong')).rejects.toBeInstanceOf(
      PaymentWebhookSignatureError
    );
  });

  it('parseWebhook rejects malformed payloads and round-trips events', async () => {
    const adapter = createMemoryPaymentAdapter();
    const { providerRef } = await adapter.createIntent(cardIntent());
    const event = adapter.eventFor(providerRef, 'payment_succeeded');

    await expect(adapter.parseWebhook('not json', 'memory-signature')).rejects.toBeInstanceOf(
      PaymentWebhookPayloadError
    );
    await expect(adapter.parseWebhook('{"nope":1}', 'memory-signature')).rejects.toBeInstanceOf(
      PaymentWebhookPayloadError
    );

    const parsed = await adapter.parseWebhook(JSON.stringify(event), 'memory-signature');
    expect(parsed).toMatchObject({
      eventId: event.eventId,
      type: 'payment_succeeded',
      providerRef,
      orderId: ORDER_ID,
      amountMinor: 12_500,
    });
    expect(parsed.occurredAt).toBeInstanceOf(Date);
  });

  it('failWith makes provider calls reject with the configured error', async () => {
    const adapter = createMemoryPaymentAdapter();
    adapter.failWith(new PaymentAdapterError('provider down', 503));
    await expect(adapter.createIntent(cardIntent())).rejects.toThrow('provider down');
    adapter.failWith(null);
    await expect(adapter.createIntent(cardIntent())).resolves.toBeDefined();
  });
});

describe('offline payment adapter', () => {
  it('records an offline intent with no external call — pending, no client secret', async () => {
    const adapter = createOfflinePaymentAdapter({ generateRef: () => 'offline_test_1' });
    const result = await adapter.createIntent(cardIntent({ method: 'offline' }));
    expect(result).toEqual({
      provider: 'offline',
      providerRef: 'offline_test_1',
      status: 'pending',
      clientSecret: null,
    });
  });

  it('rejects non-offline methods', async () => {
    const adapter = createOfflinePaymentAdapter();
    await expect(adapter.createIntent(cardIntent())).rejects.toBeInstanceOf(PaymentAdapterError);
  });

  it('reports intents as pending (awaiting reconciliation) and has no refunds or webhooks', async () => {
    const adapter = createOfflinePaymentAdapter();
    await expect(adapter.getIntent('offline_x')).resolves.toMatchObject({ status: 'pending' });
    await expect(adapter.refund('offline_x')).rejects.toBeInstanceOf(PaymentAdapterError);
    await expect(adapter.parseWebhook('{}', 'sig')).rejects.toBeInstanceOf(PaymentAdapterError);
  });
});
