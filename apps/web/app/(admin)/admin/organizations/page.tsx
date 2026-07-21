import Link from 'next/link';
import { Plus } from 'lucide-react';

import { isSuperAdmin, type Organization } from '@assessify/domain';
import { getOrganizationService } from '@assessify/services';
import { Button, Card } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { ForbiddenCard } from '../../_components/forbidden-card';
import { OrganizationStatusBadge } from './_components/status-badge';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * Organizations list (M4). Super admins see every organization (platform
 * manages orgs); org admins see just their own, resolved via listContexts —
 * the service's list() is deliberately super_admin-only.
 */
export default async function OrganizationsPage() {
  const caller = await requireCallerContext();
  const service = getOrganizationService();
  const superAdmin = isSuperAdmin(caller);

  let organizations: Organization[] = [];
  if (superAdmin) {
    const result = await service.list(caller);
    if (!result.ok) {
      return (
        <PageFrame superAdmin={false}>
          <Card className="p-6 text-sm text-red">{result.error.message}</Card>
        </PageFrame>
      );
    }
    organizations = result.value;
  } else {
    const contexts = await service.listContexts(caller);
    const orgIds = contexts.ok
      ? contexts.value.flatMap((option) => (option.kind === 'organization' ? [option.id] : []))
      : [];
    if (orgIds.length === 0) {
      return (
        <PageFrame superAdmin={false}>
          <ForbiddenCard message="Organizations are managed by super admins and each organization's own admins. Your account is not an admin of any organization." />
        </PageFrame>
      );
    }
    const results = await Promise.all(orgIds.map((id) => service.get(caller, id)));
    organizations = results.flatMap((result) => (result.ok ? [result.value] : []));
  }

  return (
    <PageFrame superAdmin={superAdmin}>
      {organizations.length === 0 ? (
        <Card className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm font-medium text-ink">No organizations yet</p>
          <p className="text-sm text-muted">
            Create the first product owner organization to assign products to.
          </p>
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Slug</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Settlement currency</th>
                <th className="px-4 py-3">Updated</th>
              </tr>
            </thead>
            <tbody>
              {organizations.map((organization) => (
                <tr
                  key={organization.id}
                  className="border-b border-border transition-colors last:border-0 hover:bg-primary-tint/40"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/organizations/${organization.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {organization.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-body">{organization.slug}</td>
                  <td className="px-4 py-3">
                    <OrganizationStatusBadge status={organization.status} />
                  </td>
                  <td className="px-4 py-3 text-body">{organization.settlementCurrency}</td>
                  <td className="px-4 py-3 text-muted">
                    {organization.updatedAt.toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </PageFrame>
  );
}

function PageFrame({
  superAdmin,
  children,
}: {
  superAdmin: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-ink">Organizations</h1>
        {superAdmin ? (
          <Button asChild>
            <Link href="/admin/organizations/new">
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
              New organization
            </Link>
          </Button>
        ) : null}
      </div>
      {children}
    </div>
  );
}
