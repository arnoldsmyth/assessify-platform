'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getProductService } from '@assessify/services';

import { devActor } from './_lib/actor';
import { formStateFromError, parseProductFormData, type ProductFormState } from './_lib/form';

// TODO(A3): gate on CallerContext — derive the actor from the session instead
// of the devActor stub once auth lands (coordinator wires at merge).

export async function createProductAction(
  _prev: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const result = await getProductService().create(devActor, parseProductFormData(formData));
  if (!result.ok) return formStateFromError(result.error);
  revalidatePath('/admin/products');
  redirect(`/admin/products/${result.value.id}`);
}

export async function updateProductAction(
  id: string,
  _prev: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const result = await getProductService().update(devActor, id, parseProductFormData(formData));
  if (!result.ok) return formStateFromError(result.error);
  revalidatePath('/admin/products');
  revalidatePath(`/admin/products/${id}`);
  redirect('/admin/products');
}

export async function archiveProductAction(id: string): Promise<void> {
  const result = await getProductService().archive(devActor, id);
  if (!result.ok) {
    // Expected failures surface as a thrown message here only because archive
    // has no form state channel; the id comes from a server-rendered page.
    throw new Error(result.error.message);
  }
  revalidatePath('/admin/products');
  revalidatePath(`/admin/products/${id}`);
  redirect('/admin/products');
}
