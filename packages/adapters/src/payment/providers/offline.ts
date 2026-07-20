/**
 * Offline payment provider (docs/spec/06-orders-and-state-machine.md:
 * "no-op intent; order moves to `approved` immediately with an open
 * invoice; admin marks invoice paid manually").
 *
 * No external call is ever made: createIntent just mints a reference and
 * reports `pending` — "recorded, awaiting reconciliation". The payment
 * SERVICE reacts by recording the payment row and confirming the order
 * (offline confirmed → approved); invoice reconciliation is the billing
 * epic's job (H-series). Refunds and webhooks do not exist offline.
 */
import { randomUUID } from 'node:crypto';

import {
  PaymentAdapterError,
  type PaymentAdapter,
  type PaymentIntentResult,
  type PaymentIntentSnapshot,
} from '../types';

export interface OfflinePaymentAdapterOptions {
  /** Override for deterministic refs in tests. */
  generateRef?: () => string;
}

export function createOfflinePaymentAdapter(
  options: OfflinePaymentAdapterOptions = {}
): PaymentAdapter {
  const generateRef = options.generateRef ?? (() => `offline_${randomUUID()}`);

  return {
    provider: 'offline',

    async createIntent(input): Promise<PaymentIntentResult> {
      if (input.method !== 'offline') {
        throw new PaymentAdapterError(
          'the offline provider only records offline payments',
          undefined,
          true
        );
      }
      return {
        provider: 'offline',
        providerRef: generateRef(),
        // Recorded, awaiting reconciliation — the invoice is settled manually.
        status: 'pending',
        clientSecret: null,
      };
    },

    async getIntent(providerRef): Promise<PaymentIntentSnapshot> {
      // There is no provider-side record; the `payments` row is the truth.
      return { providerRef, status: 'pending', amountMinor: null, currency: null };
    },

    async refund(): Promise<never> {
      throw new PaymentAdapterError(
        'offline payments are refunded manually against the invoice',
        undefined,
        true
      );
    },

    async parseWebhook(): Promise<never> {
      throw new PaymentAdapterError('the offline provider has no webhooks', undefined, true);
    },
  };
}
