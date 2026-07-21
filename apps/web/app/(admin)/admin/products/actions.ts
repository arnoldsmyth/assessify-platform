'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getOrganizationService, getProductService } from '@assessify/services';

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

/**
 * Move the product to another organization (super_admin — spec: platform
 * assigns products). Deliberately NOT part of the ordinary edit form: it is
 * an explicit service operation with its own audit action.
 */
export async function reassignProductOrganizationAction(
  productId: string,
  formData: FormData
): Promise<void> {
  const caller = await requireCallerContext();
  const organizationId = String(formData.get('organizationId') ?? '');
  const result = await getOrganizationService().assignProductToOrg(
    caller,
    productId,
    organizationId
  );
  if (!result.ok) {
    // Row action without a form-state channel; the ids come from a
    // server-rendered select, so an expected failure still surfaces loudly.
    throw new Error(result.error.message);
  }
  revalidatePath('/admin/products');
  revalidatePath(`/admin/products/${productId}`);
  revalidatePath(`/admin/organizations/${organizationId}`);
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
