import Link from 'next/link';
import { Plus } from 'lucide-react';

import { isSuperAdmin } from '@assessify/domain';
import { getClientService, getOrganizationService } from '@assessify/services';
import { Button, Card } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { ForbiddenCard } from '../../_components/forbidden-card';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * Clients list (O1), org-scoped: super_admin sees every client (across
 * organizations); an org admin sees only their organization's clients. The
 * table is intentionally a plain `<table>` for now — a shared responsive
 * table primitive is a separate issue.
 */
export default async function ClientsPage() {
  const caller = await requireCallerContext();
  const clientsResult = await getClientService().list(caller);

  if (!clientsResult.ok) {
    return (
      <PageFrame canCreate={false}>
        <ForbiddenCard message={clientsResult.error.message} />
      </PageFrame>
    );
  }
  const clients = clientsResult.value;

  // Resolve organization names for the table's Organization column. Super
  // admins get the full org list; org admins get just their own via
  // listContexts (already scoped — no extra per-org fetch needed).
  const organizationService = getOrganizationService();
  let orgNameById = new Map<string, string>();
  if (isSuperAdmin(caller)) {
    const orgsResult = await organizationService.list(caller);
    if (orgsResult.ok) {
      orgNameById = new Map(orgsResult.value.map((organization) => [organization.id, organization.name]));
    }
  } else {
    const contextsResult = await organizationService.listContexts(caller);
    if (contextsResult.ok) {
      orgNameById = new Map(
        contextsResult.value.flatMap((option) =>
          option.kind === 'organization' ? [[option.id, option.name] as const] : []
        )
      );
    }
  }

  return (
    <PageFrame canCreate>
      {clients.length === 0 ? (
        <Card className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm font-medium text-ink">No clients yet</p>
          <p className="text-sm text-muted">
            Create the first client to start placing orders for them.
          </p>
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Number</th>
                <th className="px-4 py-3">Organization</th>
                <th className="px-4 py-3">Default currency</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr
                  key={client.id}
                  className="border-b border-border transition-colors last:border-0 hover:bg-primary-tint/40"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/clients/${client.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {client.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-body">{client.clientNumber}</td>
                  <td className="px-4 py-3 text-body">
                    {orgNameById.get(client.organizationId) ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-body">{client.defaultCurrency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </PageFrame>
  );
}

function PageFrame({ canCreate, children }: { canCreate: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-ink">Clients</h1>
        {canCreate ? (
          <Button asChild>
            <Link href="/admin/clients/new">
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
              New client
            </Link>
          </Button>
        ) : null}
      </div>
      {children}
    </div>
  );
}
