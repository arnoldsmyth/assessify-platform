import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { getOrganizationService } from '@assessify/services';
import { Card } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { createProductAction } from '../actions';
import { ProductForm } from '../_components/product-form';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  const caller = await requireCallerContext();

  // Every product belongs to an organization (M2) — the create form needs
  // the picker. Product creation is super_admin, so the full org list applies.
  const orgsResult = await getOrganizationService().list(caller);
  const activeOrgs = orgsResult.ok
    ? orgsResult.value
        .filter((organization) => organization.status === 'active')
        .map((organization) => ({ id: organization.id, name: organization.name }))
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/admin/products"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Products
        </Link>
        <h1 className="text-xl font-semibold text-ink">New product</h1>
      </div>
      {!orgsResult.ok ? (
        <Card className="p-6 text-sm text-red">{orgsResult.error.message}</Card>
      ) : activeOrgs.length === 0 ? (
        <Card className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm font-medium text-ink">No active organizations</p>
          <p className="text-sm text-muted">
            Every product belongs to an organization.{' '}
            <Link href="/admin/organizations/new" className="text-primary underline">
              Create one
            </Link>{' '}
            first, then come back to add the product.
          </p>
        </Card>
      ) : (
        <ProductForm
          action={createProductAction}
          submitLabel="Create product"
          organizations={activeOrgs}
        />
      )}
    </div>
  );
}
