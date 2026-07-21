import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { isSuperAdmin } from '@assessify/domain';
import {
  getClientDirectoryService,
  getProductService,
  getQuestionnaireVersionService,
} from '@assessify/services';
import { Card } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { createOrderAction } from '../actions';
import { OrderWizard, type WizardClient, type WizardProduct } from '../_components/order-wizard';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

export default async function NewOrderPage() {
  const caller = await requireCallerContext();

  const [clientsResult, productsResult] = await Promise.all([
    getClientDirectoryService().listPlaceable(caller),
    getProductService().listOrderable(caller),
  ]);

  if (!clientsResult.ok || !productsResult.ok || clientsResult.value.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <h1 className="text-xl font-semibold text-ink">New order</h1>
        <Card className="p-6 text-sm text-muted">
          You do not have permission to place orders for any client. Ask a client admin (or a
          super admin) to grant the ordering permission.
        </Card>
      </div>
    );
  }

  // No retail-umbrella exclusion any more (owner decision 2026-07-21: direct
  // sales become an ordinary client) — every placeable client is offered.
  const clients: WizardClient[] = clientsResult.value.map((client) => ({
    id: client.id,
    name: client.name,
    clientNumber: client.clientNumber,
    defaultCurrency: client.defaultCurrency,
  }));

  // Resolve each product's active 'self' questionnaire version — the wizard
  // pins it on the order (spec 06). Products without one are shown disabled.
  const versionService = getQuestionnaireVersionService();
  const products: WizardProduct[] = await Promise.all(
    productsResult.value.map(async (product): Promise<WizardProduct> => {
      const versions = await versionService.listActiveForOrdering(caller, product.id);
      const activeSelf = versions.ok
        ? (versions.value.find((version) => version.variant === 'self') ?? null)
        : null;
      return {
        id: product.id,
        name: product.name,
        defaultLanguage: product.defaultLanguage,
        availableLanguages: product.availableLanguages,
        retailPrice: product.retailPrice,
        retailCurrency: product.retailCurrency,
        activeSelfVersion: activeSelf ? { id: activeSelf.id, version: activeSelf.version } : null,
      };
    })
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <BackLink />
        <h1 className="text-xl font-semibold text-ink">New order</h1>
        <p className="text-sm text-muted">
          Named and bulk named orders — respondents are known now; invitations go out after
          payment approval.
        </p>
      </div>

      <OrderWizard
        clients={clients}
        products={products}
        isSuperAdmin={isSuperAdmin(caller)}
        action={createOrderAction}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/orders"
      className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
    >
      <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
      Orders
    </Link>
  );
}
