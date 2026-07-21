import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { isSuperAdmin } from '@assessify/domain';

import { requireCallerContext } from '@/lib/caller-context';

import { ForbiddenCard } from '../../../_components/forbidden-card';
import { createOrganizationAction } from '../actions';
import { OrganizationForm } from '../_components/organization-form';

export const dynamic = 'force-dynamic';

export default async function NewOrganizationPage() {
  const caller = await requireCallerContext();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/admin/organizations"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Organizations
        </Link>
        <h1 className="text-xl font-semibold text-ink">New organization</h1>
      </div>
      {isSuperAdmin(caller) ? (
        <OrganizationForm action={createOrganizationAction} submitLabel="Create organization" />
      ) : (
        <ForbiddenCard message="Only super admins can create organizations." />
      )}
    </div>
  );
}
