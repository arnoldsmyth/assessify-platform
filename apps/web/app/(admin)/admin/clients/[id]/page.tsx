import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { getClientService, getOrganizationService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import { ForbiddenCard } from '../../../_components/forbidden-card';
import { updateClientAction } from '../actions';
import { ClientForm } from '../_components/client-form';
import { toFormValues } from '../_lib/form';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * Client detail/edit (O1): super_admin, or an admin of the client's own
 * organization — the service enforces this; the page just renders the typed
 * errors. Org reassignment is not part of this CRUD surface (the form has no
 * organization picker here).
 */
export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const caller = await requireCallerContext();

  const clientResult = await getClientService().get(caller, id);
  if (!clientResult.ok) {
    if (clientResult.error.code === 'client/not_found') notFound();
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold text-ink">Client</h1>
        <ForbiddenCard message={clientResult.error.message} />
      </div>
    );
  }
  const client = clientResult.value;

  // Best-effort org name for the header — the client fetch above already
  // proved the caller may see this client, so a failure here is unusual and
  // simply falls back to omitting the name.
  const orgResult = await getOrganizationService().get(caller, client.organizationId);
  const organizationName = orgResult.ok ? orgResult.value.name : null;

  const updateAction = updateClientAction.bind(null, client.id);

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
        <h1 className="text-xl font-semibold text-ink">{client.name}</h1>
        <p className="font-mono text-xs text-muted">
          Client #{client.clientNumber}
          {organizationName ? ` · ${organizationName}` : ''}
        </p>
      </div>

      <ClientForm action={updateAction} defaults={toFormValues(client)} submitLabel="Save changes" />
    </div>
  );
}
