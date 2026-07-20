import {
  ok,
  err,
  type CallerContext,
  type Order,
  type Payment,
} from '@assessify/domain';
import { PaymentAdapterError, type PaymentEvent } from '@assessify/adapters';
import type { OrderRepository, PaymentRepository } from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import type { OrderService } from '../orders';
import { createPaymentService, type PaymentServiceDeps } from './payment-service';

const CLIENT_ID = '33333333-3333-7333-8333-333333333333';
const PRODUCT_ID = '55555555-5555-7555-8555-555555555555';
const ORDER_ID = '01890000-0000-7000-8000-000000000042';
const PAYMENT_ID = '01890000-0000-7000-8000-00000000aaaa';

const superAdmin: CallerContext = {
  kind: 'user',
  id: '11111111-1111-7111-8111-111111111111',
  roles: [{ role: 'super_admin', productId: null, clientId: null, permissions: { products: [], groups: [], canPlaceOrders: false, canViewResults: false, canReleaseReports: false } }],
};

function order(overrides: Partial<Order> = {}): Order {
  const now = new Date('2026-07-20T10:00:00Z');
  return {
    id: ORDER_ID,
    reference: 'ORD-00042',
    type: 'named',
    status: 'pending',
    clientId: CLIENT_ID,
    productId: PRODUCT_ID,
    questionnaireVersionId: '66666666-6666-7666-8666-666666666666',
    reportTemplateVersionId: null,
    reportLanguage: 'en',
    reportModel: 'individual',
    currency: 'EUR',
    subtotal: 12_500,
    discountTotal: 0,
    total: 12_500,
    paymentProvider: null,
    entitlementId: null,
    notificationPolicy: null,
    suppressNotifications: false,
    expectedRespondents: null,
    pageSize: null,
    isTest: false,
    relatedOrderId: null,
    placedByUserId: null,
    placedVia: 'admin',
    errorDetail: null,
    source: 'native',
    legacyId: null,
    approvedAt: null,
    sentAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Order;
}

function payment(overrides: Partial<Payment> = {}): Payment {
  const now = new Date('2026-07-20T10:05:00Z');
  return {
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    invoiceId: null,
    provider: 'stripe',
    providerRef: 'pi_1',
    method: 'card',
    status: 'requires_action',
    amount: 12_500,
    currency: 'EUR',
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function event(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    eventId: 'evt_1',
    type: 'payment_succeeded',
    provider: 'stripe',
    providerRef: 'pi_1',
    orderId: ORDER_ID,
    amountMinor: 12_500,
    currency: 'EUR',
    occurredAt: new Date('2026-07-20T10:06:00Z'),
    ...overrides,
  };
}

interface Fixture {
  deps: PaymentServiceDeps;
  paymentsRepo: {
    insert: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByOrderId: ReturnType<typeof vi.fn>;
    findByProviderRef: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
  };
  ordersRepo: { setPaymentProvider: ReturnType<typeof vi.fn> };
  orderService: { get: ReturnType<typeof vi.fn>; transition: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn> };
}

function fixture(overrides: Partial<PaymentServiceDeps> = {}): Fixture {
  const paymentsRepo = {
    insert: vi.fn(async (input: Record<string, unknown>) => payment(input as Partial<Payment>)),
    findById: vi.fn(async () => null),
    findByOrderId: vi.fn(async () => []),
    findByProviderRef: vi.fn(async () => null),
    updateStatus: vi.fn(async (_id: string, _expected: unknown, patch: { status: Payment['status'] }) =>
      payment({ status: patch.status })
    ),
  };
  const ordersRepo = { setPaymentProvider: vi.fn(async () => undefined) };
  const orderService = {
    get: vi.fn(async () => ok({ order: order(), items: [] })),
    transition: vi.fn(async () => ok(order({ status: 'approved' }))),
  };
  const audit = { record: vi.fn(async () => ok({} as never)) };

  const deps: PaymentServiceDeps = {
    payments: paymentsRepo as unknown as PaymentRepository,
    orders: ordersRepo as unknown as Pick<OrderRepository, 'setPaymentProvider'>,
    orderService: orderService as unknown as Pick<OrderService, 'get' | 'transition'>,
    audit: audit as unknown as AuditService,
    generateId: () => PAYMENT_ID,
    ...overrides,
  };
  return { deps, paymentsRepo, ordersRepo, orderService, audit };
}

function stripeAdapterMock() {
  return {
    provider: 'stripe' as const,
    createIntent: vi.fn(async () => ({
      provider: 'stripe' as const,
      providerRef: 'pi_1',
      status: 'requires_action' as const,
      clientSecret: 'pi_1_secret',
    })),
    getIntent: vi.fn(),
    refund: vi.fn(async () => ({
      provider: 'stripe' as const,
      refundRef: 're_1',
      status: 'succeeded' as const,
      amountMinor: 12_500,
    })),
    parseWebhook: vi.fn(),
  };
}

function offlineAdapterMock() {
  return {
    provider: 'offline' as const,
    createIntent: vi.fn(async () => ({
      provider: 'offline' as const,
      providerRef: 'offline_1',
      status: 'pending' as const,
      clientSecret: null,
    })),
    getIntent: vi.fn(),
    refund: vi.fn(),
    parseWebhook: vi.fn(),
  };
}

describe('paymentService.initiate', () => {
  it('card: creates a provider intent, records the payment row, returns the client secret, no order transition', async () => {
    const stripe = stripeAdapterMock();
    const f = fixture({ adapters: { stripe } });
    const service = createPaymentService(f.deps);

    const result = await service.initiate(superAdmin, { orderId: ORDER_ID, method: 'card' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clientSecret).toBe('pi_1_secret');
    expect(result.value.payment.status).toBe('requires_action');

    expect(stripe.createIntent).toHaveBeenCalledWith({
      amountMinor: 12_500,
      currency: 'EUR',
      method: 'card',
      metadata: { orderId: ORDER_ID },
    });
    expect(f.paymentsRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PAYMENT_ID,
        orderId: ORDER_ID,
        provider: 'stripe',
        providerRef: 'pi_1',
        method: 'card',
        status: 'requires_action',
        amount: 12_500,
        currency: 'EUR',
      })
    );
    expect(f.ordersRepo.setPaymentProvider).toHaveBeenCalledWith(ORDER_ID, 'stripe');
    // Card orders stay `pending` until the provider webhook confirms.
    expect(f.orderService.transition).not.toHaveBeenCalled();
    expect(f.audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: superAdmin.id },
      'payment.initiated',
      { type: 'payment', id: PAYMENT_ID },
      expect.objectContaining({ orderId: ORDER_ID, provider: 'stripe', method: 'card' })
    );
  });

  it('rejects orders that are not pending, before any provider call', async () => {
    const stripe = stripeAdapterMock();
    const f = fixture({ adapters: { stripe } });
    f.orderService.get.mockResolvedValue(ok({ order: order({ status: 'approved' }), items: [] }));
    const service = createPaymentService(f.deps);

    const result = await service.initiate(superAdmin, { orderId: ORDER_ID, method: 'card' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('payment/order_not_payable');
    expect(stripe.createIntent).not.toHaveBeenCalled();
    expect(f.paymentsRepo.insert).not.toHaveBeenCalled();
  });

  it('propagates order-service authz/not-found errors', async () => {
    const f = fixture({ adapters: { stripe: stripeAdapterMock() } });
    f.orderService.get.mockResolvedValue(
      err({ code: 'order/not_found', message: 'Order not found' })
    );
    const service = createPaymentService(f.deps);

    const result = await service.initiate(superAdmin, { orderId: ORDER_ID, method: 'card' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('order/not_found');
  });

  it('offline: records the payment immediately and confirms the order via the order service', async () => {
    const offline = offlineAdapterMock();
    const f = fixture({ adapters: { offline } });
    const service = createPaymentService(f.deps);

    const result = await service.initiate(superAdmin, { orderId: ORDER_ID, method: 'offline' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clientSecret).toBeNull();
    expect(f.paymentsRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'offline', method: 'offline', status: 'pending' })
    );
    // Offline confirmed → approved, THROUGH the order service, as the caller.
    expect(f.orderService.transition).toHaveBeenCalledWith(superAdmin, ORDER_ID, {
      event: 'payment_succeeded',
      reason: 'offline_payment_recorded',
    });
  });

  it('reports a missing adapter and provider failures as typed errors', async () => {
    const noAdapters = createPaymentService(fixture({ adapters: {} }).deps);
    const unavailable = await noAdapters.initiate(superAdmin, { orderId: ORDER_ID, method: 'card' });
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) expect(unavailable.error.code).toBe('payment/provider_unavailable');

    const stripe = stripeAdapterMock();
    stripe.createIntent.mockRejectedValue(new PaymentAdapterError('declined', 402, true));
    const f = fixture({ adapters: { stripe } });
    const service = createPaymentService(f.deps);
    const failed = await service.initiate(superAdmin, { orderId: ORDER_ID, method: 'card' });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('payment/provider_error');
    expect(f.paymentsRepo.insert).not.toHaveBeenCalled();
  });

  it('rejects invalid payloads', async () => {
    const service = createPaymentService(fixture().deps);
    const result = await service.initiate(superAdmin, { orderId: 'nope', method: 'cash' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('payment/validation');
  });
});

describe('paymentService.handleEvent', () => {
  it('success event: transitions the order (system caller) then settles the payment row', async () => {
    const f = fixture();
    f.paymentsRepo.findByProviderRef.mockResolvedValue(payment());
    const service = createPaymentService(f.deps);

    const result = await service.handleEvent(event());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ outcome: 'applied', paymentId: PAYMENT_ID, orderId: ORDER_ID });
    expect(f.orderService.transition).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'system' }),
      ORDER_ID,
      { event: 'payment_succeeded', reason: 'provider_event:evt_1' }
    );
    expect(f.paymentsRepo.updateStatus).toHaveBeenCalledWith(
      PAYMENT_ID,
      ['requires_action', 'pending', 'failed'],
      { status: 'succeeded', error: null }
    );
    expect(f.audit.record).toHaveBeenCalledWith(
      { kind: 'system', id: 'system' },
      'payment.succeeded',
      { type: 'payment', id: PAYMENT_ID },
      expect.objectContaining({ eventId: 'evt_1', orderTransition: 'applied' })
    );
  });

  it('redelivered success event is a duplicate: no transition, no update', async () => {
    const f = fixture();
    f.paymentsRepo.findByProviderRef.mockResolvedValue(payment({ status: 'succeeded' }));
    const service = createPaymentService(f.deps);

    const result = await service.handleEvent(event());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('duplicate');
    expect(f.orderService.transition).not.toHaveBeenCalled();
    expect(f.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('tolerates an already-approved order (replayed event after a crash) and still settles the row', async () => {
    const f = fixture();
    f.paymentsRepo.findByProviderRef.mockResolvedValue(payment());
    f.orderService.transition.mockResolvedValue(
      err({ code: 'order/illegal_transition', message: 'not allowed' })
    );
    const service = createPaymentService(f.deps);

    const result = await service.handleEvent(event());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('applied');
    expect(f.paymentsRepo.updateStatus).toHaveBeenCalled();
  });

  it('losing the CAS race to a concurrent delivery reports a duplicate', async () => {
    const f = fixture();
    f.paymentsRepo.findByProviderRef.mockResolvedValue(payment());
    f.paymentsRepo.updateStatus.mockResolvedValue(null);
    const service = createPaymentService(f.deps);

    const result = await service.handleEvent(event());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('duplicate');
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('other order-transition failures bubble up as errors so the provider retries', async () => {
    const f = fixture();
    f.paymentsRepo.findByProviderRef.mockResolvedValue(payment());
    f.orderService.transition.mockResolvedValue(
      err({ code: 'order/conflict', message: 'concurrent change' })
    );
    const service = createPaymentService(f.deps);

    const result = await service.handleEvent(event());
    expect(result.ok).toBe(false);
    expect(f.paymentsRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('failure event: order → payment_error with failure detail, payment row → failed', async () => {
    const f = fixture();
    f.paymentsRepo.findByProviderRef.mockResolvedValue(payment());
    const service = createPaymentService(f.deps);

    const result = await service.handleEvent(
      event({ type: 'payment_failed', eventId: 'evt_2', failure: { code: 'card_declined' } })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('applied');
    expect(f.orderService.transition).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'system' }),
      ORDER_ID,
      {
        event: 'payment_failed',
        errorDetail: { eventId: 'evt_2', providerRef: 'pi_1', code: 'card_declined' },
      }
    );
    expect(f.paymentsRepo.updateStatus).toHaveBeenCalledWith(
      PAYMENT_ID,
      ['requires_action', 'pending'],
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('stale failure after success never regresses the payment or the order', async () => {
    const f = fixture();
    f.paymentsRepo.findByProviderRef.mockResolvedValue(payment({ status: 'succeeded' }));
    const service = createPaymentService(f.deps);

    const result = await service.handleEvent(event({ type: 'payment_failed' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('stale');
    expect(f.orderService.transition).not.toHaveBeenCalled();
    expect(f.paymentsRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('refund event: full refunds mark refunded, partial mark partially_refunded, no order transition', async () => {
    const f = fixture();
    f.paymentsRepo.findByProviderRef.mockResolvedValue(payment({ status: 'succeeded' }));
    const service = createPaymentService(f.deps);

    const full = await service.handleEvent(event({ type: 'refund_completed', amountMinor: 12_500 }));
    expect(full.ok && full.value.outcome).toBe('applied');
    expect(f.paymentsRepo.updateStatus).toHaveBeenLastCalledWith(
      PAYMENT_ID,
      ['succeeded', 'partially_refunded'],
      { status: 'refunded' }
    );

    const partial = await service.handleEvent(
      event({ type: 'refund_completed', amountMinor: 2_500, eventId: 'evt_3' })
    );
    expect(partial.ok && partial.value.outcome).toBe('applied');
    expect(f.paymentsRepo.updateStatus).toHaveBeenLastCalledWith(
      PAYMENT_ID,
      ['succeeded', 'partially_refunded'],
      { status: 'partially_refunded' }
    );
    // Order refund (completed → refunded) stays an admin action (spec 06).
    expect(f.orderService.transition).not.toHaveBeenCalled();
  });

  it('unmatched refs, checkout events, and unhandled types are acknowledged without action', async () => {
    const f = fixture();
    const service = createPaymentService(f.deps);

    const unmatched = await service.handleEvent(event({ providerRef: 'pi_foreign' }));
    expect(unmatched.ok && unmatched.value.outcome).toBe('unmatched');

    const checkout = await service.handleEvent(event({ type: 'checkout_completed' }));
    expect(checkout.ok && checkout.value.outcome).toBe('ignored');

    const unhandled = await service.handleEvent(event({ type: 'unhandled' }));
    expect(unhandled.ok && unhandled.value.outcome).toBe('ignored');
    expect(f.orderService.transition).not.toHaveBeenCalled();
  });
});

describe('paymentService.refund', () => {
  it('super_admin requests a provider refund; the webhook finalises the row', async () => {
    const stripe = stripeAdapterMock();
    const f = fixture({ adapters: { stripe } });
    f.paymentsRepo.findById.mockResolvedValue(payment({ status: 'succeeded' }));
    const service = createPaymentService(f.deps);

    const result = await service.refund(superAdmin, { paymentId: PAYMENT_ID, amountMinor: 2_500 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refund.refundRef).toBe('re_1');
    expect(stripe.refund).toHaveBeenCalledWith('pi_1', 2_500);
    expect(f.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    expect(f.audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: superAdmin.id },
      'payment.refund_requested',
      { type: 'payment', id: PAYMENT_ID },
      expect.objectContaining({ refundRef: 're_1' })
    );
  });

  it('rejects non-admin callers and unsettled payments', async () => {
    const stripe = stripeAdapterMock();
    const f = fixture({ adapters: { stripe } });
    f.paymentsRepo.findById.mockResolvedValue(payment({ status: 'pending' }));
    const service = createPaymentService(f.deps);

    const nonAdmin = await service.refund(
      { kind: 'user', id: superAdmin.id, roles: [] },
      { paymentId: PAYMENT_ID }
    );
    expect(nonAdmin.ok).toBe(false);
    if (!nonAdmin.ok) expect(nonAdmin.error.code).toBe('payment/forbidden');

    const unsettled = await service.refund(superAdmin, { paymentId: PAYMENT_ID });
    expect(unsettled.ok).toBe(false);
    if (!unsettled.ok) expect(unsettled.error.code).toBe('payment/not_refundable');
    expect(stripe.refund).not.toHaveBeenCalled();
  });
});
