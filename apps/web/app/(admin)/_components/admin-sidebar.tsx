'use client';

import { cn } from '@assessify/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { adminNavItems } from './nav-items';

export function AdminSidebar({
  errorCount = 0,
  hasOrgScope = false,
}: {
  /** Open error-state orders (super admins only) — badge on "Error queue". */
  errorCount?: number;
  /** super_admin or org admin — shows org-scoped nav items (M4). */
  hasOrgScope?: boolean;
}) {
  const pathname = usePathname();
  const items = adminNavItems.filter((item) => !item.requiresOrgScope || hasOrgScope);

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-ink text-white">
      <div className="flex h-14 items-center px-5">
        <Link href="/admin" className="text-base font-semibold tracking-tight">
          Assessify
        </Link>
      </div>
      <nav aria-label="Admin" className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => {
            const active =
              item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-bright',
                    active
                      ? 'bg-white/10 text-white before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary-bright'
                      : 'text-white/70 hover:bg-white/5 hover:text-white'
                  )}
                >
                  <item.icon size={20} strokeWidth={1.75} aria-hidden="true" />
                  {item.label}
                  {item.href === '/admin/errors' && errorCount > 0 ? (
                    <span
                      aria-label={`${errorCount} open error${errorCount === 1 ? '' : 's'}`}
                      className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-red px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white"
                    >
                      {errorCount > 99 ? '99+' : errorCount}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
