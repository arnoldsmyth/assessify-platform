'use server';

import { revalidatePath } from 'next/cache';

import { getOrganizationService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import { accessStateFromError, type AccessFormState } from './_lib/form';

export async function grantAccessAction(
  productId: string,
  _prev: AccessFormState,
  formData: FormData
): Promise<AccessFormState> {
  const caller = await requireCallerContext();
  const clientId = formData.get('clientId');
  const result = await getOrganizationService().grantClientProductAccess(caller, {
    clientId: typeof clientId === 'string' ? clientId : '',
    productId,
  });
  if (!result.ok) return accessStateFromError(result.error);
  revalidatePath(`/admin/products/${productId}/access`);
  return { status: 'idle' };
}

export async function revokeAccessAction(productId: string, clientId: string): Promise<void> {
  const caller = await requireCallerContext();
  const result = await getOrganizationService().revokeClientProductAccess(caller, {
    clientId,
    productId,
  });
  if (!result.ok) {
    // Row action without a form-state channel; the ids come from a
    // server-rendered row, so an expected failure still surfaces loudly.
    throw new Error(result.error.message);
  }
  revalidatePath(`/admin/products/${productId}/access`);
}
