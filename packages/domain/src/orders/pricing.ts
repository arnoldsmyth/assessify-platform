import type { ProductPrice } from '../organizations/organization';

/**
 * Order unit-price resolution (M3 — spec 06 wizard step 3, M1 price list).
 *
 * The resolution chain, evaluated for the order's (report language, currency):
 *
 *   1. Exact `product_prices` row (product, language, currency) — the
 *      org-maintained per-language-edition price list.
 *   2. The product's retail/list price, only when the order currency equals
 *      `retail_currency` (mixed-currency fallbacks are never guessed).
 *   3. Nothing — the order is unpriced and creation is rejected
 *      (`order/no_price_for_language`), unless a super_admin manually
 *      overrides the price (spec 06: discounts/overrides are super_admin
 *      only).
 *
 * Client contracted prices (entitlements — H1) slot in ahead of the price
 * list when that epic lands (spec 06 pricing: contracted → list/retail).
 *
 * Shared by the order service (enforcement) and the order wizard (display) so
 * both always agree. Pure — no I/O.
 */

/** The slice of a price-list row resolution needs. */
export type OrderPriceRow = Pick<ProductPrice, 'language' | 'currency' | 'unitPrice'>;

/** Product pricing inputs for resolution (all money integer minor units). */
export interface OrderPricingSource {
  /** The product's `product_prices` rows. */
  prices: ReadonlyArray<OrderPriceRow>;
  retailPrice: number | null;
  retailCurrency: string | null;
}

export interface ResolvedUnitPrice {
  /** Integer minor units. */
  unitPrice: number;
  source: 'price_list' | 'retail';
}

/** Resolve the unit price for (language, currency), or null when unpriced. */
export function resolveOrderUnitPrice(
  source: OrderPricingSource,
  language: string,
  currency: string
): ResolvedUnitPrice | null {
  const exact = source.prices.find(
    (row) => row.language === language && row.currency === currency
  );
  if (exact) return { unitPrice: exact.unitPrice, source: 'price_list' };
  if (source.retailPrice !== null && source.retailCurrency === currency) {
    return { unitPrice: source.retailPrice, source: 'retail' };
  }
  return null;
}

/**
 * Currencies in which an order for this language edition CAN be priced
 * (price-list rows for the language, plus the retail currency when a retail
 * price is set), A→Z. Empty means only a super_admin manual price works.
 */
export function orderableCurrencies(source: OrderPricingSource, language: string): string[] {
  const currencies = new Set(
    source.prices.filter((row) => row.language === language).map((row) => row.currency)
  );
  if (source.retailPrice !== null && source.retailCurrency !== null) {
    currencies.add(source.retailCurrency);
  }
  return [...currencies].sort();
}
