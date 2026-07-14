import type { ReactNode } from 'react';

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
  await requireCallerContext();
  return (
    <div className="flex min-h-screen text-sm">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AdminHeader />
        <main className="flex-1 overflow-y-auto bg-surface-page p-6">{children}</main>
      </div>
    </div>
  );
}
