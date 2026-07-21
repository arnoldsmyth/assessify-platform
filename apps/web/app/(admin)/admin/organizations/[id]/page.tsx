import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Archive, ArrowLeft } from 'lucide-react';

import { isSuperAdmin, type Organization, type Product } from '@assessify/domain';
import { getOrganizationService, getProductService, type ClientSummary } from '@assessify/services';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { ForbiddenCard } from '../../../_components/forbidden-card';
import { archiveOrganizationAction, updateOrganizationAction } from '../actions';
import { assignProductToOrganizationAction } from './actions';
import { DefaultAccessBadge } from '../_components/access-badge';
import { OrganizationForm } from '../_components/organization-form';
import { OrganizationStatusBadge } from '../_components/status-badge';
import { toFormValues } from '../_lib/form';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * Organization detail (M4): edit (super_admin), the org's products (with
 * assign/move controls for super_admin) and a read-only client list. Org
 * admins get a read-only view of their own org — the service enforces all
 * of this; the page just renders the typed errors.
 */
export default async function OrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const caller = await requireCallerContext();
  const service = getOrganizationService();

  const orgResult = await service.get(caller, id);
  if (!orgResult.ok) {
    if (orgResult.error.code === 'organization/not_found') notFound();
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-ink">Organization</h1>
        <ForbiddenCard message={orgResult.error.message} />
      </div>
    );
  }
  const organization = orgResult.value;
  const superAdmin = isSuperAdmin(caller);

  const [productsResult, clientsResult] = await Promise.all([
    service.listOrgProducts(caller, id),
    service.listOrgClients(caller, id),
  ]);
  const products = productsResult.ok ? productsResult.value : [];
  const clients = clientsResult.ok ? clientsResult.value : [];

  // Super admins can pull a product in from another organization.
  let assignableProducts: Product[] = [];
  if (superAdmin) {
    const allProducts = await getProductService().list(caller, { page: 1, pageSize: 100 });
    if (allProducts.ok) {
      assignableProducts = allProducts.value.items.filter(
        (product) => product.organizationId !== id
      );
    }
  }

  const archiveAction = archiveOrganizationAction.bind(null, organization.id);
  const updateAction = updateOrganizationAction.bind(null, organization.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            href="/admin/organizations"
            className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
          >
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            Organizations
          </Link>
          <h1 className="flex items-center gap-3 text-xl font-semibold text-ink">
            {organization.name}
            <OrganizationStatusBadge status={organization.status} />
          </h1>
          <p className="font-mono text-xs text-muted">{organization.slug}</p>
        </div>
        {superAdmin && organization.status === 'active' ? (
          <form action={archiveAction}>
            <Button type="submit" variant="outline">
              <Archive size={16} strokeWidth={1.75} aria-hidden="true" />
              Archive organization
            </Button>
          </form>
        ) : null}
      </div>

      {superAdmin ? (
        <OrganizationForm
          action={updateAction}
          defaults={toFormValues(organization)}
          submitLabel="Save changes"
        />
      ) : (
        <ReadOnlyDetails organization={organization} />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Products</CardTitle>
          <CardDescription>
            Products owned by this organization. Pricing and client access are managed per
            product.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 p-0">
          {productsResult.ok ? (
            <ProductsTable products={products} superAdmin={superAdmin} />
          ) : (
            <p className="px-6 pb-4 text-sm text-muted">{productsResult.error.message}</p>
          )}
          {superAdmin && assignableProducts.length > 0 ? (
            <form
              action={assignProductToOrganizationAction.bind(null, organization.id)}
              className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-4"
            >
              <label htmlFor="assign-product" className="text-sm font-medium text-ink">
                Assign a product to this organization
              </label>
              <select
                id="assign-product"
                name="productId"
                required
                defaultValue=""
                className="flex h-9 rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <option value="" disabled>
                  Choose a product…
                </option>
                {assignableProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="outline" size="sm">
                Assign
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Clients</CardTitle>
          <CardDescription>
            The organization&rsquo;s clients (read-only here). Restricted products grant access
            per client on the product&rsquo;s client access page.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {clientsResult.ok ? (
            <ClientsTable clients={clients} />
          ) : (
            <p className="px-6 pb-4 text-sm text-muted">{clientsResult.error.message}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ReadOnlyDetails({ organization }: { organization: Organization }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Details</CardTitle>
        <CardDescription>Organization settings are managed by super admins.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Settlement email</p>
          <p className="text-body">{organization.settlementEmail ?? '—'}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Settlement currency
          </p>
          <p className="text-body">{organization.settlementCurrency}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function ProductsTable({ products, superAdmin }: { products: Product[]; superAdmin: boolean }) {
  if (products.length === 0) {
    return (
      <p className="px-6 pb-4 text-sm text-muted">No products are assigned to this organization.</p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
            <th className="px-6 py-3">Name</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Access</th>
            <th className="px-4 py-3 text-right">Manage</th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <tr key={product.id} className="border-b border-border last:border-0">
              <td className="px-6 py-3">
                {superAdmin ? (
                  <Link
                    href={`/admin/products/${product.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {product.name}
                  </Link>
                ) : (
                  <span className="font-medium text-ink">{product.name}</span>
                )}
              </td>
              <td className="px-4 py-3 text-body">
                {product.status === 'active' ? 'Active' : 'Retired'}
              </td>
              <td className="px-4 py-3">
                <DefaultAccessBadge defaultAccess={product.defaultAccess} />
              </td>
              <td className="px-4 py-3 text-right">
                <span className="inline-flex items-center gap-3">
                  <Link
                    href={`/admin/products/${product.id}/pricing`}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Pricing
                  </Link>
                  <Link
                    href={`/admin/products/${product.id}/access`}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Client access
                  </Link>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClientsTable({ clients }: { clients: ClientSummary[] }) {
  if (clients.length === 0) {
    return <p className="px-6 pb-4 text-sm text-muted">This organization has no clients yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
            <th className="px-6 py-3">Client</th>
            <th className="px-4 py-3">Number</th>
            <th className="px-4 py-3">Default currency</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((client) => (
            <tr key={client.id} className="border-b border-border last:border-0">
              <td className="px-6 py-3 font-medium text-ink">{client.name}</td>
              <td className="px-4 py-3 font-mono text-xs text-body">{client.clientNumber}</td>
              <td className="px-4 py-3 text-body">{client.defaultCurrency}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
