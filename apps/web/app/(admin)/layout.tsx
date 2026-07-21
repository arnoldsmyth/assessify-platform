import type { ReactNode } from 'react';

import { isSuperAdmin, orgScopeIds, type CallerContextOption } from '@assessify/domain';
import { getErrorQueueService, getOrganizationService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import { AdminHeader } from './_components/admin-header';
import { AdminSidebar } from './_components/admin-sidebar';

/**
 * Admin shell (spec 15): dark-ink left sidebar with orange active indicator,
 * breadcrumb + page-actions header, white/neutral content area. Base font
 * size 14 in admin (dense tables). Assessify-branded — never renders
 * respondent components (spec 03).
 *
 * Gated on a Better Auth session (redirects to /login). Per-feature
 * permission-matrix enforcement happens in the service layer (spec 05).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const caller = await requireCallerContext();

  // "Error states alert an admin" (spec 06): open-error badge on the nav.
  // Super admin only — the error queue is their surface; best-effort, a
  // failed count never breaks the shell.
  let errorCount = 0;
  if (isSuperAdmin(caller)) {
    const counts = await getErrorQueueService()
      .countOpen(caller)
      .catch(() => null);
    if (counts?.ok) errorCount = counts.value.total;
  }

  // Context indicator (M4, minimal — full switcher lands with J2). Best
  // effort: a failed lookup never breaks the shell.
  let contexts: CallerContextOption[] = [];
  const contextsResult = await getOrganizationService()
    .listContexts(caller)
    .catch(() => null);
  if (contextsResult?.ok) contexts = contextsResult.value;

  const hasOrgScope = isSuperAdmin(caller) || orgScopeIds(caller).length > 0;

  return (
    <div className="flex min-h-screen text-sm">
      <AdminSidebar errorCount={errorCount} hasOrgScope={hasOrgScope} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AdminHeader contexts={contexts} />
        <main className="flex-1 overflow-y-auto bg-surface-page p-6">{children}</main>
      </div>
    </div>
  );
}
