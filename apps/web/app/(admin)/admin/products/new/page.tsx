import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

import { createProductAction } from '../actions';
import { ProductForm } from '../_components/product-form';

export default function NewProductPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/admin/products"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
          Products
        </Link>
        <h1 className="text-xl font-semibold text-ink">New product</h1>
      </div>
      <ProductForm action={createProductAction} submitLabel="Create product" />
    </div>
  );
}
