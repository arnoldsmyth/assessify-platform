'use client';

import { usePathname } from 'next/navigation';

import { adminNavItems } from './nav-items';

/**
 * Breadcrumb + page-actions header (spec 15 admin layout). Breadcrumb is
 * derived from the nav config for now; page actions are rendered by pages
 * into the right-hand slot once real sections land.
 */
export function AdminHeader() {
  const pathname = usePathname();
  const section = adminNavItems.find((item) =>
    item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href)
  );

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
        <span className="text-muted">Admin</span>
        {section ? (
          <>
            <span className="text-muted" aria-hidden="true">
              /
            </span>
            <span className="font-medium text-ink">{section.label}</span>
          </>
        ) : null}
      </nav>
      {/* Page actions slot — populated per page when sections are built. */}
      <div className="flex items-center gap-2" />
    </header>
  );
}
