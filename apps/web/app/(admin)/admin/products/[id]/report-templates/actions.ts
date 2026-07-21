'use server';

import { revalidatePath } from 'next/cache';

import { getWebReportTemplateService } from '@/lib/reports';
import { requireCallerContext } from '@/lib/caller-context';

import {
  capabilitiesFromForm,
  readTemplateFromForm,
  uploadStateFromError,
  type TemplateUploadFormState,
} from './_lib/form';

export async function uploadReportTemplateAction(
  productId: string,
  _prev: TemplateUploadFormState,
  formData: FormData
): Promise<TemplateUploadFormState> {
  const caller = await requireCallerContext();

  const raw = await readTemplateFromForm(formData);
  if (!raw.ok) return { status: 'error', message: raw.message };

  const result = await getWebReportTemplateService().upload(caller, {
    productId,
    html: raw.html,
    capabilities: capabilitiesFromForm(formData),
  });
  if (!result.ok) return uploadStateFromError(result.error);

  revalidatePath(`/admin/products/${productId}/report-templates`);
  return {
    status: 'success',
    message: `Uploaded version ${result.value.version} as a draft.`,
  };
}

export async function activateReportTemplateAction(
  productId: string,
  templateVersionId: string
): Promise<void> {
  const caller = await requireCallerContext();
  const result = await getWebReportTemplateService().activate(caller, templateVersionId);
  if (!result.ok) {
    // No form-state channel for row actions; ids come from a server-rendered
    // page, so an expected failure here still surfaces loudly.
    throw new Error(result.error.message);
  }
  revalidatePath(`/admin/products/${productId}/report-templates`);
}

export async function retireReportTemplateAction(
  productId: string,
  templateVersionId: string
): Promise<void> {
  const caller = await requireCallerContext();
  const result = await getWebReportTemplateService().retire(caller, templateVersionId);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  revalidatePath(`/admin/products/${productId}/report-templates`);
}
