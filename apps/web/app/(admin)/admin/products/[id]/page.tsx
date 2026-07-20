import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Archive, ArrowLeft, FileJson } from 'lucide-react';

import { Button } from '@assessify/ui';
import { getProductService } from '@assessify/services';

import { archiveProductAction, updateProductAction } from '../actions';
import { ProductForm } from '../_components/product-form';
import { toFormValues } from '../_lib/form';

import { requireCallerContext } from '@/lib/caller-context';

export const dynamic = 'force-dynamic';

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const caller = await requireCallerContext();
  const result = await getProductService().get(caller, id);
  if (!result.ok) {
    if (result.error.code === 'product/not_found') notFound();
    throw new Error(result.error.message);
  }
  const product = result.value;

  const updateAction = updateProductAction.bind(null, product.id);
  const archiveAction = archiveProductAction.bind(null, product.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            href="/admin/products"
            className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
          >
            <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            Products
          </Link>
          <h1 className="text-xl font-semibold text-ink">{product.name}</h1>
          <p className="font-mono text-xs text-muted">
            {product.slug}.assessify.ie
            {product.status === 'retired' ? ' · retired' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link href={`/admin/products/${product.id}/questionnaires`}>
              <FileJson size={16} strokeWidth={1.75} aria-hidden="true" />
              Questionnaire versions
            </Link>
          </Button>
          {product.status === 'active' ? (
            <form action={archiveAction}>
              <Button type="submit" variant="outline">
                <Archive size={16} strokeWidth={1.75} aria-hidden="true" />
                Archive product
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      <ProductForm
        action={updateAction}
        defaults={toFormValues(product)}
        submitLabel="Save changes"
      />
    </div>
  );
}
