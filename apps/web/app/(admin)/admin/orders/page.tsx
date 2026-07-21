import Link from 'next/link';
import { Plus } from 'lucide-react';

import {
  clientScopeIds,
  isSuperAdmin,
  orderStatusSchema,
  orderTypeSchema,
  orgScopeIds,
  type Order,
  type OrderStatus,
  type OrderType,
} from '@assessify/domain';
import {
  getClientDirectoryService,
  getOrderService,
  type ClientSummary,
} from '@assessify/services';
import { Button, Card } from '@assessify/ui';

import { requireCallerContext } from '@/lib/caller-context';

import { formatMinor } from './_lib/form';
import { OrderStatusBadge, ORDER_STATUS_BADGES } from './_components/status-badge';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

interface OrdersSearchParams {
  status?: string;
  type?: string;
  client?: string;
  q?: string;
  page?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<OrdersSearchParams>;
}) {
  const params = await searchParams;
  const caller = await requireCallerContext();

  const statusParsed = orderStatusSchema.safeParse(params.status);
  const status: OrderStatus | undefined = statusParsed.success ? statusParsed.data : undefined;
  const typeParsed = orderTypeSchema.safeParse(params.type);
  const type: OrderType | undefined = typeParsed.success ? typeParsed.data : undefined;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);
  const pageSize = 20;

  const clientsResult = await getClientDirectoryService().listVisible(caller);
  const visibleClients: ClientSummary[] = clientsResult.ok ? clientsResult.value : [];
  const clientNames = new Map(visibleClients.map((client) => [client.id, client.name]));

  // Scope resolution (spec 05: non-super queries must be scoped): super_admin
  // filters freely; client-scoped callers default to their first client;
  // org-scoped assessment_admins fall back to their organization (M2).
  const superAdmin = isSuperAdmin(caller);
  const requestedClientId =
    params.client && UUID_RE.test(params.client) ? params.client : undefined;
  let clientId: string | undefined;
  let organizationId: string | undefined;
  if (superAdmin) {
    clientId = requestedClientId;
  } else {
    const scope = clientScopeIds(caller);
    clientId =
      requestedClientId && scope.includes(requestedClientId) ? requestedClientId : scope[0];
    if (!clientId) organizationId = orgScopeIds(caller)[0];
  }

  const canQuery = superAdmin || clientId !== undefined || organizationId !== undefined;
  const result = canQuery
    ? await getOrderService().list(caller, {
        ...(clientId ? { clientId } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
        page,
        pageSize,
      })
    : null;

  const filterQuery = (target: number) => {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (type) query.set('type', type);
    if (params.client) query.set('client', params.client);
    if (target > 1) query.set('page', String(target));
    const qs = query.toString();
    return qs ? `/admin/orders?${qs}` : '/admin/orders';
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-ink">Orders</h1>
        <Button asChild>
          <Link href="/admin/orders/new">
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
            New order
          </Link>
        </Button>
      </div>

      <form action="/admin/orders" className="flex flex-wrap items-center gap-2">
        <select
          name="status"
          defaultValue={status ?? ''}
          aria-label="Filter by status"
          className="flex h-9 rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="">All statuses</option>
          {Object.entries(ORDER_STATUS_BADGES).map(([value, badge]) => (
            <option key={value} value={value}>
              {badge.label}
            </option>
          ))}
        </select>
        <select
          name="type"
          defaultValue={type ?? ''}
          aria-label="Filter by order model"
          className="flex h-9 rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="">All models</option>
          <option value="named">Named</option>
          <option value="bulk_named">Bulk named</option>
          <option value="multi_rater">Multi-rater</option>
          <option value="group">Group</option>
          <option value="retail">Retail</option>
          <option value="batch_code">Batch code</option>
        </select>
        {superAdmin || visibleClients.length > 1 ? (
          <select
            name="client"
            defaultValue={requestedClientId ?? ''}
            aria-label="Filter by client"
            className="flex h-9 max-w-56 rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <option value="">{superAdmin ? 'All clients' : 'Default client'}</option>
            {visibleClients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        ) : null}
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      {!canQuery ? (
        <Card className="p-6 text-sm text-muted">
          You do not have a client or organization scope that can view orders.
        </Card>
      ) : result && result.ok ? (
        <OrderTable
          items={result.value.items}
          total={result.value.total}
          page={result.value.page}
          pageSize={result.value.pageSize}
          clientNames={clientNames}
          pageHref={filterQuery}
        />
      ) : (
        <Card className="p-6 text-sm text-red">{result?.error.message}</Card>
      )}
    </div>
  );
}

function OrderTable({
  items,
  total,
  page,
  pageSize,
  clientNames,
  pageHref,
}: {
  items: Order[];
  total: number;
  page: number;
  pageSize: number;
  clientNames: Map<string, string>;
  pageHref: (page: number) => string;
}) {
  if (total === 0) {
    return (
      <Card className="flex flex-col items-start gap-2 p-6">
        <p className="text-sm font-medium text-ink">No orders found</p>
        <p className="text-sm text-muted">
          Try clearing the filters, or place the first order for this client.
        </p>
      </Card>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-3">
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
              <th className="px-4 py-3">Reference</th>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Model</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3">Placed via</th>
              <th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {items.map((order) => (
              <tr
                key={order.id}
                className="border-b border-border transition-colors last:border-0 hover:bg-primary-tint/40"
              >
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
                  {clientNames.get(order.clientId) ?? `${order.clientId.slice(0, 8)}…`}
                </td>
                <td className="px-4 py-3 text-body">{order.type.replace('_', ' ')}</td>
                <td className="px-4 py-3">
                  <OrderStatusBadge status={order.status} />
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-body">
                  {formatMinor(order.total, order.currency)}
                </td>
                <td className="px-4 py-3 text-muted">{order.placedVia}</td>
                <td className="px-4 py-3 text-muted">
                  {order.createdAt.toISOString().slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted">
        <span>
          {total} order{total === 1 ? '' : 's'}
        </span>
        {totalPages > 1 ? (
          <span className="flex items-center gap-3">
            {page > 1 ? (
              <Link className="font-medium text-primary hover:underline" href={pageHref(page - 1)}>
                Previous
              </Link>
            ) : null}
            <span>
              Page {page} of {totalPages}
            </span>
            {page < totalPages ? (
              <Link className="font-medium text-primary hover:underline" href={pageHref(page + 1)}>
                Next
              </Link>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}
