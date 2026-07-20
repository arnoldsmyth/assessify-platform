'use server';

import { revalidatePath } from 'next/cache';

import { getQuestionnaireVersionService } from '@assessify/services';

import { requireCallerContext } from '@/lib/caller-context';

import {
  importStateFromError,
  readDefinitionFromForm,
  variantFromForm,
  type QuestionnaireImportFormState,
} from './_lib/form';

export async function importQuestionnaireVersionAction(
  productId: string,
  _prev: QuestionnaireImportFormState,
  formData: FormData
): Promise<QuestionnaireImportFormState> {
  const caller = await requireCallerContext();

  const raw = await readDefinitionFromForm(formData);
  if (!raw.ok) return { status: 'error', message: raw.message };

  const result = await getQuestionnaireVersionService().importDefinition(caller, {
    productId,
    variant: variantFromForm(formData),
    definition: raw.definition,
  });
  if (!result.ok) return importStateFromError(result.error);

  revalidatePath(`/admin/products/${productId}/questionnaires`);
  return {
    status: 'success',
    message: `Imported version ${result.value.version} (${result.value.variant}) as a draft.`,
  };
}

export async function activateQuestionnaireVersionAction(
  productId: string,
  versionId: string
): Promise<void> {
  const caller = await requireCallerContext();
  const result = await getQuestionnaireVersionService().activate(caller, versionId);
  if (!result.ok) {
    // No form-state channel for row actions; ids come from a server-rendered
    // page, so an expected failure here still surfaces loudly.
    throw new Error(result.error.message);
  }
  revalidatePath(`/admin/products/${productId}/questionnaires`);
}

export async function retireQuestionnaireVersionAction(
  productId: string,
  versionId: string
): Promise<void> {
  const caller = await requireCallerContext();
  const result = await getQuestionnaireVersionService().retire(caller, versionId);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/admin/products/${productId}/questionnaires`);
}
