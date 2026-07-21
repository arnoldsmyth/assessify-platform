import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { getOrganizationService } from '@assessify/services';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { ForbiddenCard } from '../../../../_components/forbidden-card';
import { DefaultAccessBadge } from '../../../organizations/_components/access-badge';
import { grantAccessAction, revokeAccessAction } from './actions';
import { GrantForm } from './_components/grant-form';
import { RevokeButton } from './_components/revoke-button';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * Client product-access editor (M4). Lives under the product because the
 * service is product-keyed (grants, listClientProductAccess) — the org
 * detail links here per product. Org-default products need no grants;
 * restricted products manage per-client grants from the org's client list.
 */
export default async function ProductAccessPage({
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
        <h1 className="text-xl font-semibold text-ink">Client access</h1>
        <ForbiddenCard message={productResult.error.message} />
      </div>
    );
  }
  const product = productResult.value;

  const [grantsResult, clientsResult] = await Promise.all([
    service.listClientProductAccess(caller, id),
    service.listOrgClients(caller, product.organizationId),
  ]);
  if (!grantsResult.ok) throw new Error(grantsResult.error.message);
  if (!clientsResult.ok) throw new Error(clientsResult.error.message);

  const clients = clientsResult.value;
  const clientNames = new Map(clients.map((client) => [client.id, client.name]));
  const grants = [...grantsResult.value].sort((a, b) =>
    (clientNames.get(a.clientId) ?? '').localeCompare(clientNames.get(b.clientId) ?? '')
  );
  const grantedIds = new Set(grants.map((grant) => grant.clientId));
  const grantableClients = clients.filter((client) => !grantedIds.has(client.id));

  const grantAction = grantAccessAction.bind(null, product.id);

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
        <h1 className="flex items-center gap-3 text-xl font-semibold text-ink">
          Client access
          <DefaultAccessBadge defaultAccess={product.defaultAccess} />
        </h1>
        <p className="text-sm text-muted">
          {product.defaultAccess
            ? `${product.name} is an org-default product — every client of its organization can order it without a grant.`
            : `${product.name} is restricted — only clients granted access below can order it.`}
        </p>
      </div>

      {product.defaultAccess ? (
        <Card className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm font-medium text-ink">No grants needed</p>
          <p className="text-sm text-muted">
            Per-client grants only apply to restricted products. To restrict this product, turn
            off default access on the product&rsquo;s edit form.
          </p>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Granted clients</CardTitle>
            <CardDescription>
              Clients of the product&rsquo;s organization with access to this product.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {grants.length === 0 ? (
              <p className="text-sm text-muted">
                No clients have access yet — nobody can order this product until a grant is
                added.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
                      <th className="py-3 pr-4">Client</th>
                      <th className="px-4 py-3">Granted</th>
                      <th className="px-4 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grants.map((grant) => {
                      const name = clientNames.get(grant.clientId) ?? `${grant.clientId.slice(0, 8)}…`;
                      return (
                        <tr key={grant.clientId} className="border-b border-border last:border-0">
                          <td className="py-3 pr-4 font-medium text-ink">{name}</td>
                          <td className="px-4 py-3 text-muted">
                            {grant.createdAt.toISOString().slice(0, 10)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end">
                              <RevokeButton
                                clientName={name}
                                action={revokeAccessAction.bind(null, product.id, grant.clientId)}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <GrantForm
              action={grantAction}
              clients={grantableClients.map((client) => ({ id: client.id, name: client.name }))}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
