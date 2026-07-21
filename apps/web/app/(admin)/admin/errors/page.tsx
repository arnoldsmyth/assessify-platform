import Link from 'next/link';
import type { ReactNode } from 'react';

import { ORDER_ERROR_STATUSES, type NotificationLogEntry } from '@assessify/domain';
import {
  getErrorQueueService,
  type ErrorQueueCounts,
  type ErrorQueueEntry,
  type OrderErrorStatus,
} from '@assessify/services';
import { Card, CardContent, CardHeader, CardTitle, cn } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { OrderStatusBadge, ORDER_STATUS_BADGES } from '../orders/_components/status-badge';
import { retryOrderAction } from './actions';
import { RetryButton } from './_components/retry-button';
import { retryLabel, summarizeErrorDetail } from './_lib/queue';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

/**
 * Admin error queue (D7 — spec 06 "error states alert an admin and offer
 * retry"): a focused view over orders in `payment_error` / `email_error` /
 * `scoring_error` with inline retry, plus recent failed/bounced emails from
 * `notification_log` (spec 13) for context. Super-admin only — the
 * error-queue service enforces it; this page just renders the typed error.
 * Order investigation stays on the order detail page (D2) — rows link there.
 */

interface ErrorsSearchParams {
  status?: string;
  page?: string;
}

const PAGE_SIZE = 20;

function isErrorStatus(value: string | undefined): value is OrderErrorStatus {
  return (
    value !== undefined && (ORDER_ERROR_STATUSES as readonly string[]).includes(value)
  );
}

function queueHref(status: OrderErrorStatus | undefined, page: number): string {
  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (page > 1) query.set('page', String(page));
  const qs = query.toString();
  return qs ? `/admin/errors?${qs}` : '/admin/errors';
}

function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

export default async function ErrorQueuePage({
  searchParams,
}: {
  searchParams: Promise<ErrorsSearchParams>;
}) {
  const params = await searchParams;
  const caller = await requireCallerContext();

  const status = isErrorStatus(params.status) ? params.status : undefined;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const service = getErrorQueueService();
  const [countsResult, listResult, notificationsResult] = await Promise.all([
    service.countOpen(caller),
    service.list(caller, { ...(status ? { status } : {}), page, pageSize: PAGE_SIZE }),
    service.listFailedNotifications(caller, { limit: 25 }),
  ]);

  if (!listResult.ok) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-ink">Error queue</h1>
        <Card className="p-6 text-sm text-muted">{listResult.error.message}</Card>
      </div>
    );
  }

  const counts: ErrorQueueCounts = countsResult.ok
    ? countsResult.value
    : { total: 0, byStatus: { payment_error: 0, email_error: 0, scoring_error: 0 } };
  const { items, total } = listResult.value;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-ink">Error queue</h1>
        <p className="text-sm text-muted">
          Orders stuck in an error state. Retrying re-runs the failed step; every retry is
          recorded in the order&apos;s audit trail.
        </p>
      </div>

      <nav aria-label="Filter by error type" className="flex flex-wrap items-center gap-2">
        <FilterChip href={queueHref(undefined, 1)} active={status === undefined}>
          All open ({counts.total})
        </FilterChip>
        {ORDER_ERROR_STATUSES.map((errorStatus) => (
          <FilterChip
            key={errorStatus}
            href={queueHref(errorStatus, 1)}
            active={status === errorStatus}
          >
            {ORDER_STATUS_BADGES[errorStatus].label}s ({counts.byStatus[errorStatus]})
          </FilterChip>
        ))}
      </nav>

      {items.length === 0 ? (
        <Card className="flex flex-col items-start gap-2 p-6">
          <p className="text-sm font-medium text-ink">The queue is clear</p>
          <p className="text-sm text-muted">
            No orders are currently in {status ? `the ${status.replace('_', ' ')} state` : 'an error state'}.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <Card className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Error</th>
                  <th className="px-4 py-3">Detail</th>
                  <th className="px-4 py-3">Since</th>
                  <th className="px-4 py-3 text-right">Retries</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <QueueRow key={entry.order.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </Card>

          <div className="flex items-center justify-between text-sm text-muted">
            <span>
              {total} order{total === 1 ? '' : 's'} in {status ? 'this state' : 'error states'}
            </span>
            {totalPages > 1 ? (
              <span className="flex items-center gap-3">
                {page > 1 ? (
                  <Link
                    className="font-medium text-primary hover:underline"
                    href={queueHref(status, page - 1)}
                  >
                    Previous
                  </Link>
                ) : null}
                <span>
                  Page {page} of {totalPages}
                </span>
                {page < totalPages ? (
                  <Link
                    className="font-medium text-primary hover:underline"
                    href={queueHref(status, page + 1)}
                  >
                    Next
                  </Link>
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent failed emails</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {notificationsResult.ok ? (
            <FailedNotificationsTable entries={notificationsResult.value} />
          ) : (
            <p className="px-6 pb-4 text-sm text-muted">{notificationsResult.error.message}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-primary-tint text-primary-tint-ink'
          : 'border-border bg-surface text-muted hover:text-ink'
      )}
    >
      {children}
    </Link>
  );
}

function QueueRow({ entry }: { entry: ErrorQueueEntry }) {
  const { order } = entry;
  return (
    <tr className="border-b border-border transition-colors last:border-0 hover:bg-primary-tint/40">
      <td className="px-4 py-3">
        <Link
          href={`/admin/orders/${order.id}`}
          className="font-mono text-xs font-medium text-primary hover:underline"
        >
          {order.reference}
        </Link>
        {order.isTest ? (
          <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
            Test
          </span>
        ) : null}
      </td>
      <td className="px-4 py-3 text-body">
        {entry.clientName ?? `${order.clientId.slice(0, 8)}…`}
      </td>
      <td className="px-4 py-3 text-body">
        {entry.productName ?? `${order.productId.slice(0, 8)}…`}
      </td>
      <td className="px-4 py-3">
        <OrderStatusBadge status={order.status} />
      </td>
      <td className="max-w-72 px-4 py-3 text-body">
        {summarizeErrorDetail(order.errorDetail)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted">
        {formatTimestamp(entry.enteredErrorAt)}
      </td>
      <td className="px-4 py-3 text-right text-body">{entry.retryCount}</td>
      <td className="px-4 py-3 text-right">
        <RetryButton
          label={retryLabel(entry.retryEvent)}
          action={retryOrderAction.bind(null, order.id, entry.retryEvent)}
        />
      </td>
    </tr>
  );
}

const NOTIFICATION_BADGES: Record<string, string> = {
  failed: 'bg-red-tint text-red',
  bounced: 'bg-amber-tint text-amber',
};

function FailedNotificationsTable({ entries }: { entries: NotificationLogEntry[] }) {
  if (entries.length === 0) {
    return <p className="px-6 pb-4 text-sm text-muted">No failed or bounced emails.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
          <th className="px-6 py-2">Kind</th>
          <th className="px-4 py-2">Template</th>
          <th className="px-4 py-2">Recipient</th>
          <th className="px-4 py-2">Status</th>
          <th className="px-4 py-2">Order</th>
          <th className="px-4 py-2">When</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id} className="border-b border-border last:border-0">
            <td className="px-6 py-2 text-body">{entry.kind.replace('_', ' ')}</td>
            <td className="px-4 py-2 font-mono text-xs text-body">{entry.template}</td>
            <td className="px-4 py-2 text-body">{entry.recipient}</td>
            <td className="px-4 py-2">
              <span
                className={cn(
                  'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
                  NOTIFICATION_BADGES[entry.status] ?? 'border border-border bg-surface text-muted'
                )}
              >
                {entry.status}
              </span>
            </td>
            <td className="px-4 py-2">
              {entry.orderId ? (
                <Link
                  href={`/admin/orders/${entry.orderId}`}
                  className="font-mono text-xs font-medium text-primary hover:underline"
                >
                  View order
                </Link>
              ) : (
                <span className="text-muted">—</span>
              )}
            </td>
            <td className="px-4 py-2 whitespace-nowrap text-muted">
              {formatTimestamp(entry.updatedAt)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
