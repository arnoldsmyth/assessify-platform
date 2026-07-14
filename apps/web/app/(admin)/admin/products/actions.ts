'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getProductService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import { formStateFromError, parseProductFormData, type ProductFormState } from './_lib/form';

export async function createProductAction(
  _prev: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const caller = await requireCallerContext();
  const result = await getProductService().create(caller, parseProductFormData(formData));
  if (!result.ok) return formStateFromError(result.error);
  revalidatePath('/admin/products');
  redirect(`/admin/products/${result.value.id}`);
}

export async function updateProductAction(
  id: string,
  _prev: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const caller = await requireCallerContext();
  const result = await getProductService().update(caller, id, parseProductFormData(formData));
  if (!result.ok) return formStateFromError(result.error);
  revalidatePath('/admin/products');
  revalidatePath(`/admin/products/${id}`);
  redirect('/admin/products');
}

export async function archiveProductAction(id: string): Promise<void> {
  const caller = await requireCallerContext();
  const result = await getProductService().archive(caller, id);
  if (!result.ok) {
    // Expected failures surface as a thrown message here only because archive
    // has no form state channel; the id comes from a server-rendered page.
    throw new Error(result.error.message);
  }
  revalidatePath('/admin/products');
  revalidatePath(`/admin/products/${id}`);
  redirect('/admin/products');
}
