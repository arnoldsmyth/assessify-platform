import { describe, expect, it } from 'vitest';

import {
  orderableCurrencies,
  resolveOrderUnitPrice,
  type OrderPricingSource,
} from './pricing';

const source = (overrides: Partial<OrderPricingSource> = {}): OrderPricingSource => ({
  prices: [
    { language: 'en', currency: 'EUR', unitPrice: 15000 },
    { language: 'en', currency: 'USD', unitPrice: 16500 },
    { language: 'fr', currency: 'EUR', unitPrice: 15500 },
  ],
  retailPrice: null,
  retailCurrency: null,
  ...overrides,
});

describe('resolveOrderUnitPrice', () => {
  it('resolves the exact (language, currency) price-list row first', () => {
    expect(resolveOrderUnitPrice(source(), 'en', 'EUR')).toEqual({
      unitPrice: 15000,
      source: 'price_list',
    });
    expect(resolveOrderUnitPrice(source(), 'fr', 'EUR')).toEqual({
      unitPrice: 15500,
      source: 'price_list',
    });
  });

  it('falls back to the retail price only when the currency matches', () => {
    const retail = source({ prices: [], retailPrice: 12000, retailCurrency: 'EUR' });
    expect(resolveOrderUnitPrice(retail, 'en', 'EUR')).toEqual({
      unitPrice: 12000,
      source: 'retail',
    });
    // Mixed-currency fallback is never guessed.
    expect(resolveOrderUnitPrice(retail, 'en', 'USD')).toBeNull();
  });

  it('prefers the price list over the retail fallback', () => {
    const both = source({ retailPrice: 999, retailCurrency: 'EUR' });
    expect(resolveOrderUnitPrice(both, 'en', 'EUR')).toEqual({
      unitPrice: 15000,
      source: 'price_list',
    });
  });

  it('returns null when neither the price list nor retail covers the pair', () => {
    expect(resolveOrderUnitPrice(source(), 'fr', 'USD')).toBeNull();
    expect(resolveOrderUnitPrice(source({ prices: [] }), 'en', 'EUR')).toBeNull();
  });

  it('supports a zero price (free editions are priced, not unpriced)', () => {
    const free = source({ prices: [{ language: 'en', currency: 'EUR', unitPrice: 0 }] });
    expect(resolveOrderUnitPrice(free, 'en', 'EUR')).toEqual({
      unitPrice: 0,
      source: 'price_list',
    });
  });
});

describe('orderableCurrencies', () => {
  it('lists price-list currencies for the language plus the retail currency, A→Z', () => {
    const withRetail = source({ retailPrice: 12000, retailCurrency: 'GBP' });
    expect(orderableCurrencies(withRetail, 'en')).toEqual(['EUR', 'GBP', 'USD']);
    expect(orderableCurrencies(withRetail, 'fr')).toEqual(['EUR', 'GBP']);
  });

  it('is empty when the language is unpriced and no retail price is set', () => {
    expect(orderableCurrencies(source(), 'de')).toEqual([]);
  });

  it('ignores the retail currency when no retail price is set', () => {
    expect(orderableCurrencies(source({ retailCurrency: 'GBP' }), 'fr')).toEqual(['EUR']);
  });
});
