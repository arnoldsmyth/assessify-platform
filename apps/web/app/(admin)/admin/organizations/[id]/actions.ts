'use server';

import { revalidatePath } from 'next/cache';

import { getOrganizationService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

/**
 * Pull a product into this organization (super_admin — the service
 * enforces it). The product id comes from a server-rendered select; an
 * expected failure has no form-state channel here, so it surfaces loudly.
 */
export async function assignProductToOrganizationAction(
  organizationId: string,
  formData: FormData
): Promise<void> {
  const caller = await requireCallerContext();
  const productId = String(formData.get('productId') ?? '');
  const result = await getOrganizationService().assignProductToOrg(
    caller,
    productId,
    organizationId
  );
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/admin/organizations/${organizationId}`);
  revalidatePath(`/admin/products/${productId}`);
  revalidatePath('/admin/products');
}
