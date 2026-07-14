import Link from 'next/link';
import { Plus } from 'lucide-react';

import { Button, Card, Input } from '@assessify/ui';
import { getProductService } from '@assessify/services';
import type { Product } from '@assessify/domain';

import { devActor } from './_lib/actor';

// Reads live data on every request — never prerendered at build time.
export const dynamic = 'force-dynamic';

interface ProductsSearchParams {
  q?: string;
  status?: string;
  page?: string;
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<ProductsSearchParams>;
}) {
  const params = await searchParams;
  const search = params.q?.trim() || undefined;
  const status =
    params.status === 'active' || params.status === 'retired' ? params.status : undefined;
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);
  const pageSize = 20;

  // TODO(A3): gate on CallerContext once auth lands.
  const result = await getProductService().list(devActor, { search, status, page, pageSize });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-ink">Products</h1>
        <Button asChild>
          <Link href="/admin/products/new">
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
            New product
          </Link>
        </Button>
      </div>

      <form action="/admin/products" className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          name="q"
          defaultValue={search ?? ''}
          placeholder="Search by name or slug"
          className="w-64"
          aria-label="Search products"
        />
        <select
          name="status"
          defaultValue={status ?? ''}
          aria-label="Filter by status"
          className="flex h-9 rounded-md border border-border bg-surface px-3 py-1 text-sm text-body shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="retired">Retired</option>
        </select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      {result.ok ? (
        <ProductTable
          items={result.value.items}
          total={result.value.total}
          page={result.value.page}
          pageSize={result.value.pageSize}
          search={search}
          status={status}
        />
      ) : (
        <Card className="p-6 text-sm text-red">{result.error.message}</Card>
      )}
    </div>
  );
}

function ProductTable({
  items,
  total,
  page,
  pageSize,
  search,
  status,
}: {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
  search?: string;
  status?: string;
}) {
  if (total === 0) {
    return (
      <Card className="flex flex-col items-start gap-2 p-6">
        <p className="text-sm font-medium text-ink">No products found</p>
        <p className="text-sm text-muted">
          {search || status
            ? 'Try clearing the search or status filter.'
            : 'Create your first assessment product to get started.'}
        </p>
      </Card>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageHref = (target: number) => {
    const query = new URLSearchParams();
    if (search) query.set('q', search);
    if (status) query.set('status', status);
    if (target > 1) query.set('page', String(target));
    const qs = query.toString();
    return qs ? `/admin/products?${qs}` : '/admin/products';
  };

  return (
    <div className="flex flex-col gap-3">
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Subdomain</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Languages</th>
              <th className="px-4 py-3">Retail</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {items.map((product) => (
              <tr
                key={product.id}
                className="border-b border-border transition-colors last:border-0 hover:bg-primary-tint/40"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/products/${product.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {product.name}
                  </Link>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-body">
                  {product.slug}.assessify.ie
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={product.status} />
                </td>
                <td className="px-4 py-3 text-body">{product.availableLanguages.join(', ')}</td>
                <td className="px-4 py-3 text-body">
                  {product.retailEnabled && product.retailPrice !== null && product.retailCurrency
                    ? `${(product.retailPrice / 100).toFixed(2)} ${product.retailCurrency}`
                    : '—'}
                </td>
                <td className="px-4 py-3 text-muted">
                  {product.updatedAt.toISOString().slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted">
        <span>
          {total} product{total === 1 ? '' : 's'}
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

function StatusBadge({ status }: { status: Product['status'] }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-full bg-teal-tint px-2.5 py-0.5 text-xs font-medium text-teal">
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-muted">
      Retired
    </span>
  );
}
