'use server';

import { revalidatePath } from 'next/cache';

import { getTranslationService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import {
  importStateFromError,
  readImportPayloadFromForm,
  type TranslationImportFormState,
} from './_lib/form';

export async function importTranslationsAction(
  productId: string,
  _prev: TranslationImportFormState,
  formData: FormData
): Promise<TranslationImportFormState> {
  const caller = await requireCallerContext();

  const raw = await readImportPayloadFromForm(formData);
  if (!raw.ok) return { status: 'error', message: raw.message };

  // Upload shape is {language, strings}; the productId comes from the route.
  const payload = typeof raw.payload === 'object' && raw.payload !== null ? raw.payload : {};
  const result = await getTranslationService().importTranslations(caller, {
    ...payload,
    productId,
  });
  if (!result.ok) return importStateFromError(result.error);

  revalidatePath(`/admin/products/${productId}/translations`);
  return {
    status: 'success',
    message: `Imported ${result.value.importedCount} string${
      result.value.importedCount === 1 ? '' : 's'
    } for '${result.value.language}'.`,
  };
}
