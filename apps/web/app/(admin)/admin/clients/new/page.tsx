import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { isSuperAdmin } from '@assessify/domain';
import { getOrganizationService } from '@assessify/services';
import { Card } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { ForbiddenCard } from '../../../_components/forbidden-card';
import { createClientAction } from '../actions';
import { ClientForm } from '../_components/client-form';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * New client (O1). Super admins pick from every active organization; org
 * admins are fixed to their own organization(s) (resolved via
 * listContexts — already scoped, so no extra per-org fetch is needed).
 */
export default async function NewClientPage() {
  const caller = await requireCallerContext();
  const superAdmin = isSuperAdmin(caller);
  const organizationService = getOrganizationService();

  let orgOptions: { id: string; name: string }[] = [];
  if (superAdmin) {
    const orgsResult = await organizationService.list(caller);
    orgOptions = orgsResult.ok
      ? orgsResult.value
          .filter((organization) => organization.status === 'active')
          .map((organization) => ({ id: organization.id, name: organization.name }))
      : [];
  } else {
    const contextsResult = await organizationService.listContexts(caller);
    orgOptions = contextsResult.ok
      ? contextsResult.value.flatMap((option) =>
          option.kind === 'organization' ? [{ id: option.id, name: option.name }] : []
        )
      : [];
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/admin/clients"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Clients
        </Link>
        <h1 className="text-xl font-semibold text-ink">New client</h1>
      </div>
      {orgOptions.length === 0 ? (
        superAdmin ? (
          <Card className="flex flex-col items-start gap-2 p-6">
            <p className="text-sm font-medium text-ink">No active organizations</p>
            <p className="text-sm text-muted">
              Every client belongs to an organization.{' '}
              <Link href="/admin/organizations/new" className="text-primary underline">
                Create one
              </Link>{' '}
              first, then come back to add the client.
            </p>
          </Card>
        ) : (
          <ForbiddenCard message="Organizations are managed by super admins and each organization's own admins. Your account is not an admin of any organization." />
        )
      ) : (
        <ClientForm
          action={createClientAction}
          submitLabel="Create client"
          organizations={orgOptions}
        />
      )}
    </div>
  );
}
