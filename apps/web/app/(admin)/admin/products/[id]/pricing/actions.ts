'use server';

import { revalidatePath } from 'next/cache';

import { getOrganizationService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import { parsePriceFormData, priceStateFromError, type PriceFormState } from './_lib/form';

export async function upsertPriceAction(
  productId: string,
  _prev: PriceFormState,
  formData: FormData
): Promise<PriceFormState> {
  const caller = await requireCallerContext();
  const parsed = parsePriceFormData(productId, formData);
  if (!parsed.ok) return parsed.state;

  const result = await getOrganizationService().upsertPrice(caller, parsed.payload);
  if (!result.ok) return priceStateFromError(result.error);

  revalidatePath(`/admin/products/${productId}/pricing`);
  return { status: 'idle' };
}

export async function removePriceAction(
  productId: string,
  language: string,
  currency: string
): Promise<void> {
  const caller = await requireCallerContext();
  const result = await getOrganizationService().removePrice(caller, {
    productId,
    language,
    currency,
  });
  if (!result.ok) {
    // Row action without a form-state channel; the identifiers come from a
    // server-rendered row, so an expected failure still surfaces loudly.
    throw new Error(result.error.message);
  }
  revalidatePath(`/admin/products/${productId}/pricing`);
}
