import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { isSuperAdmin } from '@assessify/domain';
import { getClientDirectoryService } from '@assessify/services';
import { Card } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { createOrderAction, listWizardProductsAction } from '../actions';
import { OrderWizard } from '../_components/order-wizard';
import type { WizardClient } from '../_lib/form';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

export default async function NewOrderPage() {
  const caller = await requireCallerContext();

  const clientsResult = await getClientDirectoryService().listPlaceable(caller);

  if (!clientsResult.ok || clientsResult.value.length === 0) {
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

  // Products are NOT loaded here: the orderable catalogue depends on the
  // selected client (M3 — same organization + access), so the wizard fetches
  // it per client via the `listWizardProductsAction` server action.
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
        isSuperAdmin={isSuperAdmin(caller)}
        action={createOrderAction}
        loadProducts={listWizardProductsAction}
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
