import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { getOrganizationService } from '@assessify/services';
import { Card } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { ForbiddenCard } from '../../../../_components/forbidden-card';
import { removePriceAction, upsertPriceAction } from './actions';
import { PriceForm } from './_components/price-form';
import { RemovePriceButton } from './_components/remove-price-button';
import { formatMinor } from './_lib/form';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * Product price list (M4): language × currency × unit price rows, managed by
 * the product's org admins or super admins. Gated through
 * organizationService.getManagedProduct — deliberately NOT productService.get,
 * which is super_admin-only.
 */
export default async function ProductPricingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const caller = await requireCallerContext();
  const service = getOrganizationService();

  const productResult = await service.getManagedProduct(caller, id);
  if (!productResult.ok) {
    if (productResult.error.code === 'organization/product_not_found') notFound();
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-ink">Pricing</h1>
        <ForbiddenCard message={productResult.error.message} />
      </div>
    );
  }
  const product = productResult.value;

  const pricesResult = await service.listPrices(caller, id);
  if (!pricesResult.ok) {
    throw new Error(pricesResult.error.message);
  }
  const prices = [...pricesResult.value].sort(
    (a, b) => a.language.localeCompare(b.language) || a.currency.localeCompare(b.currency)
  );

  const upsertAction = upsertPriceAction.bind(null, product.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href={`/admin/products/${product.id}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          {product.name}
        </Link>
        <h1 className="text-xl font-semibold text-ink">Pricing</h1>
        <p className="text-sm text-muted">
          Price list for {product.name}, per language edition and currency. Amounts are stored as
          integer minor units; enter them in major units (49.50).
        </p>
      </div>

      {prices.length === 0 ? (
        <Card className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm font-medium text-ink">No prices yet</p>
          <p className="text-sm text-muted">
            Orders for this product need a price row for the ordered language and currency.
          </p>
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Language</th>
                <th className="px-4 py-3">Currency</th>
                <th className="px-4 py-3 text-right">Unit price</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((price) => (
                <tr
                  key={`${price.language}:${price.currency}`}
                  className="border-b border-border transition-colors last:border-0 hover:bg-primary-tint/40"
                >
                  <td className="px-4 py-3 font-mono text-xs text-body">{price.language}</td>
                  <td className="px-4 py-3 text-body">{price.currency}</td>
                  <td className="px-4 py-3 text-right font-medium text-ink">
                    {formatMinor(price.unitPrice, price.currency)}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {price.updatedAt.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <RemovePriceButton
                        language={price.language}
                        currency={price.currency}
                        action={removePriceAction.bind(
                          null,
                          product.id,
                          price.language,
                          price.currency
                        )}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <PriceForm action={upsertAction} languages={product.availableLanguages} />
    </div>
  );
}
