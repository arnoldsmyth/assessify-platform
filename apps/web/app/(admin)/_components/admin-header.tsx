'use client';

import { usePathname } from 'next/navigation';

import type { CallerContextOption } from '@assessify/domain';

import { ContextIndicator } from './context-indicator';
import { adminNavItems } from './nav-items';

/**
 * Breadcrumb + page-actions header (spec 15 admin layout). Breadcrumb is
 * derived from the nav config for now; the right-hand slot carries the
 * caller's context indicator (M4 — full switcher lands with J2).
 */
export function AdminHeader({ contexts = [] }: { contexts?: CallerContextOption[] }) {
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
      <div className="flex items-center gap-2">
        <ContextIndicator contexts={contexts} />
      </div>
    </header>
  );
}
