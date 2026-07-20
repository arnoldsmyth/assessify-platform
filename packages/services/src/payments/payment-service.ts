import {
  err,
  initiatePaymentSchema,
  isSuperAdmin,
  ok,
  OPEN_PAYMENT_STATUSES,
  refundPaymentSchema,
  systemCallerContext,
  uuidv7,
  type AuditActor,
  type CallerContext,
  type DomainError,
  type Payment,
  type PaymentStatus,
  type Result,
} from '@assessify/domain';
import type { PaymentAdapter, PaymentEvent, RefundResult } from '@assessify/adapters';
import type { OrderRepository, PaymentRepository } from '@assessify/repositories';

import type { AuditService } from '../audit';
import type { OrderService } from '../orders';

/**
 * Payment business logic (D3 — spec 06 "Payments (Payment Module)").
 *
 * The adapter executes charges; THIS service decides what to charge and how
 * outcomes drive the order state machine — always via `orderService.
 * transition` (payment_succeeded / payment_failed), never by writing
 * `orders.status` directly, so D1's transition table, CAS guard and audit
 * trail hold for every payment outcome.
 *
 * ## Webhook idempotency (spec 06)
 *
 * "Webhook handlers upsert `payments` by `provider_ref` and are safe to
 * replay." Dedupe is therefore keyed on the provider intent reference plus a
 * compare-and-set status update, not on a separate processed-events table:
 *
 *  1. Events resolve to a payment row via (provider, provider_ref).
 *  2. An event whose outcome the row already shows (e.g. a redelivered
 *     `payment_intent.succeeded` on a `succeeded` row) is a duplicate — the
 *     handler returns without touching the order.
 *  3. Otherwise the ORDER is transitioned first (an `order/illegal_
 *     transition` here means a replay already moved it — tolerated), and the
 *     payment row is CAS-updated from its open statuses last. Losing the CAS
 *     race to a concurrent delivery is reported as a duplicate. Because the
 *     row only reaches its final status after the order transition, a crash
 *     between the two steps self-heals on Stripe's redelivery.
 *
 * The provider event id is recorded in every audit entry for forensics. A
 * dedicated processed-events table (exactly-once by event id) would need a
 * `packages/db` migration and is intentionally not part of D3.
 *
 * PII rule: no cardholder or respondent data ever reaches this module —
 * errors and audit details carry ids, amounts and provider codes only.
 */

export interface PaymentInitiation {
  payment: Payment;
  /** Client-side confirmation secret (Stripe) — null for offline payments. */
  clientSecret: string | null;
}

export type PaymentEventOutcomeKind =
  /** The event changed state (payment row and/or order). */
  | 'applied'
  /** Redelivery of an already-applied event — nothing changed. */
  | 'duplicate'
  /** Out-of-order event that no longer applies (e.g. failure after success). */
  | 'stale'
  /** Event type or provider object this module does not act on. */
  | 'ignored'
  /** No payment row matches the provider reference (e.g. foreign environment). */
  | 'unmatched';

export interface PaymentEventOutcome {
  outcome: PaymentEventOutcomeKind;
  paymentId?: string;
  orderId?: string;
}

export interface PaymentRefundReceipt {
  payment: Payment;
  refund: RefundResult;
}

export interface PaymentService {
  /**
   * Payment step for a `pending` order (wizard step 4): card creates a
   * provider intent and returns its client secret; offline records the
   * payment immediately ("recorded, awaiting reconciliation") and confirms
   * the order (pending → approved).
   */
  initiate(caller: CallerContext, input: unknown): Promise<Result<PaymentInitiation>>;
  /**
   * Apply one (already signature-verified) provider event. Idempotent under
   * redelivery — see the module doc. Never throws for expected conditions;
   * error Results make the webhook route reply 500 so the provider retries.
   */
  handleEvent(event: PaymentEvent): Promise<Result<PaymentEventOutcome>>;
  /**
   * Request a provider refund (super_admin only, spec 06: the order moves to
   * `refunded` via the order service only AFTER the provider refund
   * succeeds — the `charge.refunded` webhook finalises the payment row).
   */
  refund(caller: CallerContext, input: unknown): Promise<Result<PaymentRefundReceipt>>;
}

/**
 * Adapter instances the composition root supplies, keyed by provider.
 * Concrete providers (Stripe REST, offline) are constructed by the app —
 * services never import providers (.dependency-cruiser.cjs). The webhook
 * path (handleEvent) needs none.
 */
export interface PaymentServiceAdapters {
  stripe?: PaymentAdapter;
  offline?: PaymentAdapter;
}

export interface PaymentServiceDeps {
  payments: PaymentRepository;
  /** Only `setPaymentProvider` is used — status writes go through the order service. */
  orders: Pick<OrderRepository, 'setPaymentProvider'>;
  orderService: Pick<OrderService, 'get' | 'transition'>;
  audit: AuditService;
  adapters?: PaymentServiceAdapters;
  generateId?: () => string;
}

// ---------------------------------------------------------------------------
// Errors — ids/amounts/provider codes only, never PII.
// ---------------------------------------------------------------------------

function validationError(issues: { path: string; message: string }[]): DomainError {
  return { code: 'payment/validation', message: 'Payment payload failed validation', detail: { issues } };
}

function zodIssues(
  issues: ReadonlyArray<{ path: (string | number)[]; message: string }>
): { path: string; message: string }[] {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function orderNotPayable(orderId: string, status: string): DomainError {
  return {
    code: 'payment/order_not_payable',
    message: `Payment can only be taken while the order is "pending" (it is "${status}")`,
    detail: { orderId, status, requiredStatus: 'pending' },
  };
}

function providerUnavailable(provider: string): DomainError {
  return {
    code: 'payment/provider_unavailable',
    message: `The payment service was composed without a "${provider}" adapter`,
    detail: { provider },
  };
}

function providerError(operation: string, cause: unknown): DomainError {
  return {
    code: 'payment/provider_error',
    message: `The payment provider rejected the ${operation}`,
    detail: { operation, cause: cause instanceof Error ? cause.message : String(cause) },
  };
}

function storageError(operation: string, cause: unknown): DomainError {
  return {
    code: 'payment/storage_failed',
    message: `Failed to ${operation} the payments store`,
    detail: { operation, cause: cause instanceof Error ? cause.message : String(cause) },
  };
}

function notFound(paymentId: string): DomainError {
  return { code: 'payment/not_found', message: 'Payment not found', detail: { paymentId } };
}

function forbidden(action: string): DomainError {
  return {
    code: 'payment/forbidden',
    message: 'You do not have permission to perform this payment action',
    detail: { action },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const SYSTEM_CALLER = systemCallerContext();

function auditActor(caller: CallerContext): AuditActor {
  return { kind: caller.kind, id: caller.id };
}

export function createPaymentService(deps: PaymentServiceDeps): PaymentService {
  const { payments, orders, orderService, audit, adapters = {} } = deps;
  const generateId = deps.generateId ?? uuidv7;

  function adapterFor(provider: 'stripe' | 'offline'): PaymentAdapter | undefined {
    return adapters[provider];
  }

  return {
    async initiate(caller, input) {
      const parsed = initiatePaymentSchema.safeParse(input);
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));
      const { orderId, method } = parsed.data;

      // The order service enforces caller scope + existence (spec 05).
      const got = await orderService.get(caller, orderId);
      if (!got.ok) return err(got.error);
      const order = got.value.order;

      // D1 machine: payment happens in `pending` only (submit reserves it;
      // payment_error is re-entered via admin retry_payment → pending).
      if (order.status !== 'pending') return err(orderNotPayable(orderId, order.status));
      if (order.total <= 0) {
        return err({
          code: 'payment/nothing_to_charge',
          message: 'The order total is zero — zero-cost orders are settled by entitlement, not payment',
          detail: { orderId, total: order.total },
        });
      }

      const provider = method === 'card' ? 'stripe' : 'offline';
      const adapter = adapterFor(provider);
      if (!adapter) return err(providerUnavailable(provider));

      let intent;
      try {
        intent = await adapter.createIntent({
          amountMinor: order.total,
          currency: order.currency,
          method,
          metadata: { orderId },
        });
      } catch (cause) {
        return err(providerError('payment intent', cause));
      }

      const status: PaymentStatus =
        intent.status === 'succeeded'
          ? 'succeeded'
          : intent.status === 'requires_action'
            ? 'requires_action'
            : intent.status === 'failed'
              ? 'failed'
              : 'pending';
      let payment: Payment;
      try {
        payment = await payments.insert({
          id: generateId(),
          orderId,
          provider: adapter.provider,
          providerRef: intent.providerRef,
          method,
          status,
          amount: order.total,
          currency: order.currency,
        });
        await orders.setPaymentProvider(orderId, adapter.provider);
      } catch (cause) {
        return err(storageError('write', cause));
      }

      const audited = await audit.record(
        auditActor(caller),
        'payment.initiated',
        { type: 'payment', id: payment.id },
        {
          orderId,
          provider: adapter.provider,
          method,
          status: payment.status,
          amount: payment.amount,
          currency: payment.currency,
          providerRef: intent.providerRef,
        }
      );
      if (!audited.ok) return err(audited.error);

      // Offline is confirmed on the spot (spec 06: order → approved
      // immediately with an open invoice; reconciliation is manual).
      if (method === 'offline') {
        const transitioned = await orderService.transition(caller, orderId, {
          event: 'payment_succeeded',
          reason: 'offline_payment_recorded',
        });
        if (!transitioned.ok) return err(transitioned.error);
      }

      return ok({ payment, clientSecret: intent.clientSecret });
    },

    async handleEvent(event) {
      // Retail Checkout events belong to the retail epic (G1); unknown
      // provider events are acknowledged so the provider stops retrying.
      if (event.type === 'unhandled' || event.type === 'checkout_completed') {
        return ok({ outcome: 'ignored' });
      }
      if (!event.providerRef) return ok({ outcome: 'ignored' });

      let payment: Payment | null;
      try {
        payment = await payments.findByProviderRef(event.provider, event.providerRef);
      } catch (cause) {
        return err(storageError('read', cause));
      }
      // Not ours (other environment, or a provider object we never created).
      if (!payment) return ok({ outcome: 'unmatched' });
      const ids = { paymentId: payment.id, ...(payment.orderId ? { orderId: payment.orderId } : {}) };

      switch (event.type) {
        case 'payment_succeeded': {
          if (payment.status === 'succeeded' || isRefunded(payment.status)) {
            return ok({ outcome: 'duplicate', ...ids });
          }
          // Order first (see module doc: crash between the two steps
          // self-heals on redelivery). A replay that already approved the
          // order surfaces as illegal_transition — tolerated.
          let orderTransition: 'applied' | 'skipped' = 'skipped';
          if (payment.orderId) {
            const transitioned = await orderService.transition(SYSTEM_CALLER, payment.orderId, {
              event: 'payment_succeeded',
              reason: `provider_event:${event.eventId}`,
            });
            if (transitioned.ok) orderTransition = 'applied';
            else if (transitioned.error.code !== 'order/illegal_transition') {
              return err(transitioned.error);
            }
          }
          let updated: Payment | null;
          try {
            updated = await payments.updateStatus(payment.id, OPEN_PAYMENT_STATUSES, {
              status: 'succeeded',
              error: null,
            });
          } catch (cause) {
            return err(storageError('update', cause));
          }
          if (!updated) return ok({ outcome: 'duplicate', ...ids });
          const audited = await audit.record(
            auditActor(SYSTEM_CALLER),
            'payment.succeeded',
            { type: 'payment', id: payment.id },
            {
              eventId: event.eventId,
              providerRef: event.providerRef,
              orderId: payment.orderId,
              amount: payment.amount,
              currency: payment.currency,
              orderTransition,
            }
          );
          if (!audited.ok) return err(audited.error);
          return ok({ outcome: 'applied', ...ids });
        }

        case 'payment_failed': {
          if (payment.status === 'failed') return ok({ outcome: 'duplicate', ...ids });
          // A failure delivered after success is stale — never regress.
          if (payment.status === 'succeeded' || isRefunded(payment.status)) {
            return ok({ outcome: 'stale', ...ids });
          }
          const failureDetail = {
            eventId: event.eventId,
            providerRef: event.providerRef,
            code: event.failure?.code ?? null,
          };
          let orderTransition: 'applied' | 'skipped' = 'skipped';
          if (payment.orderId) {
            const transitioned = await orderService.transition(SYSTEM_CALLER, payment.orderId, {
              event: 'payment_failed',
              errorDetail: failureDetail,
            });
            if (transitioned.ok) orderTransition = 'applied';
            else if (transitioned.error.code !== 'order/illegal_transition') {
              return err(transitioned.error);
            }
          }
          let updated: Payment | null;
          try {
            updated = await payments.updateStatus(payment.id, ['requires_action', 'pending'], {
              status: 'failed',
              error: failureDetail,
            });
          } catch (cause) {
            return err(storageError('update', cause));
          }
          if (!updated) return ok({ outcome: 'duplicate', ...ids });
          const audited = await audit.record(
            auditActor(SYSTEM_CALLER),
            'payment.failed',
            { type: 'payment', id: payment.id },
            { ...failureDetail, orderId: payment.orderId, orderTransition }
          );
          if (!audited.ok) return err(audited.error);
          return ok({ outcome: 'applied', ...ids });
        }

        case 'refund_completed': {
          const target: PaymentStatus =
            event.amountMinor !== null && event.amountMinor < payment.amount
              ? 'partially_refunded'
              : 'refunded';
          if (payment.status === target || payment.status === 'refunded') {
            return ok({ outcome: 'duplicate', ...ids });
          }
          // No order transition here: completed → refunded is an ADMIN
          // action taken after the provider refund succeeds (spec 06).
          let updated: Payment | null;
          try {
            updated = await payments.updateStatus(
              payment.id,
              ['succeeded', 'partially_refunded'],
              { status: target }
            );
          } catch (cause) {
            return err(storageError('update', cause));
          }
          if (!updated) return ok({ outcome: 'stale', ...ids });
          const audited = await audit.record(
            auditActor(SYSTEM_CALLER),
            'payment.refund_recorded',
            { type: 'payment', id: payment.id },
            {
              eventId: event.eventId,
              providerRef: event.providerRef,
              orderId: payment.orderId,
              refundedAmount: event.amountMinor,
              status: target,
            }
          );
          if (!audited.ok) return err(audited.error);
          return ok({ outcome: 'applied', ...ids });
        }
      }
    },

    async refund(caller, input) {
      const parsed = refundPaymentSchema.safeParse(input);
      if (!parsed.success) return err(validationError(zodIssues(parsed.error.issues)));
      const { paymentId, amountMinor } = parsed.data;

      // Refunds are super_admin only (spec 05/06: admin refund).
      if (!isSuperAdmin(caller)) return err(forbidden('refund'));

      let payment: Payment | null;
      try {
        payment = await payments.findById(paymentId);
      } catch (cause) {
        return err(storageError('read', cause));
      }
      if (!payment) return err(notFound(paymentId));
      if (
        (payment.status !== 'succeeded' && payment.status !== 'partially_refunded') ||
        !payment.providerRef
      ) {
        return err({
          code: 'payment/not_refundable',
          message: 'Only settled provider payments can be refunded',
          detail: { paymentId, status: payment.status },
        });
      }

      const adapter = payment.provider === 'stripe' ? adapterFor('stripe') : undefined;
      if (!adapter) return err(providerUnavailable(payment.provider));

      let refund: RefundResult;
      try {
        refund = await adapter.refund(payment.providerRef, amountMinor);
      } catch (cause) {
        return err(providerError('refund', cause));
      }

      const audited = await audit.record(
        auditActor(caller),
        'payment.refund_requested',
        { type: 'payment', id: payment.id },
        {
          orderId: payment.orderId,
          providerRef: payment.providerRef,
          refundRef: refund.refundRef,
          amount: amountMinor ?? payment.amount,
          refundStatus: refund.status,
        }
      );
      if (!audited.ok) return err(audited.error);

      // The payment row (and, for full refunds, the admin-driven order
      // transition) is finalised by the `charge.refunded` webhook.
      return ok({ payment, refund });
    },
  };
}

function isRefunded(status: PaymentStatus): boolean {
  return status === 'refunded' || status === 'partially_refunded';
}
