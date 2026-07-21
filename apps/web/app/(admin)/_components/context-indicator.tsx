'use client';

import Link from 'next/link';
import { ChevronDown } from 'lucide-react';

import type { CallerContextOption } from '@assessify/domain';

/**
 * Minimal context indicator (M4): shows which surfaces the caller can
 * operate in, from organizationService.listContexts. One context renders as
 * a static label; several render as a plain dropdown whose entries navigate
 * to the relevant list pages. Full switcher semantics (scoping the whole
 * shell to a context) land with J2 — this is deliberately small.
 */

function contextLabel(option: CallerContextOption): string {
  switch (option.kind) {
    case 'platform':
      return 'Platform';
    case 'organization':
      return option.name;
    case 'client':
      return option.name;
  }
}

function contextHref(option: CallerContextOption): string {
  switch (option.kind) {
    case 'platform':
      return '/admin';
    case 'organization':
      return `/admin/organizations/${option.id}`;
    case 'client':
      return '/admin/clients';
  }
}

function contextKindLabel(option: CallerContextOption): string {
  switch (option.kind) {
    case 'platform':
      return 'Platform';
    case 'organization':
      return 'Organization';
    case 'client':
      return 'Client';
  }
}

export function ContextIndicator({ contexts }: { contexts: CallerContextOption[] }) {
  if (contexts.length === 0) return null;

  const [first] = contexts;
  if (contexts.length === 1 && first) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted">
        {contextKindLabel(first)}
        {first.kind === 'platform' ? null : (
          <span className="text-ink">{contextLabel(first)}</span>
        )}
      </span>
    );
  }

  return (
    <details className="group relative">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        {contexts.length} contexts
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className="transition-transform group-open:rotate-180"
        />
      </summary>
      <ul className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-border bg-surface py-1 shadow-md">
        {contexts.map((option) => (
          <li key={option.kind === 'platform' ? 'platform' : `${option.kind}:${option.id}`}>
            <Link
              href={contextHref(option)}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm text-body hover:bg-primary-tint/40 hover:text-ink"
            >
              <span className="truncate">{contextLabel(option)}</span>
              <span className="shrink-0 text-xs uppercase tracking-wide text-muted">
                {contextKindLabel(option)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
