import type { DomainError } from '@assessify/domain';

/**
 * Shared types + FormData mapping for the report template upload form
 * (mirrors the questionnaire import form). Controllers only shape input and
 * translate errors — HTML/capability validation happens in the report
 * template service (appendix-architecture-layers.md §3a).
 */

export interface TemplateUploadIssue {
  path: string;
  message: string;
}

export interface TemplateUploadFormState {
  status: 'idle' | 'error' | 'success';
  message?: string;
  issues?: TemplateUploadIssue[];
}

export const initialUploadFormState: TemplateUploadFormState = { status: 'idle' };

export function uploadStateFromError(error: DomainError): TemplateUploadFormState {
  if (error.code === 'report_template/validation') {
    return {
      status: 'error',
      message: 'The upload was invalid — fix the issues below and retry.',
      issues: (error.detail?.issues ?? []) as TemplateUploadIssue[],
    };
  }
  return { status: 'error', message: error.message };
}

/** Pixel-perfect HTML documents with inlined assets; 5 MB is the service cap. */
const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

export type RawTemplate = { ok: true; html: string } | { ok: false; message: string };

/**
 * Pull the template HTML out of the form: an uploaded `.html` file wins over
 * the paste textarea. Content validation is the service's job.
 */
export async function readTemplateFromForm(formData: FormData): Promise<RawTemplate> {
  const file = formData.get('file');
  let text: string | null = null;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_TEMPLATE_BYTES) {
      return { ok: false, message: 'Template file is too large (5 MB max).' };
    }
    text = await file.text();
  } else {
    const pasted = formData.get('html');
    if (typeof pasted === 'string' && pasted.trim() !== '') text = pasted;
  }

  if (text === null) {
    return { ok: false, message: 'Provide a template — upload a .html file or paste HTML.' };
  }
  if (text.length > MAX_TEMPLATE_BYTES) {
    return { ok: false, message: 'Template is too large (5 MB max).' };
  }
  return { ok: true, html: text };
}

/** Checkbox mapping: unchecked boxes are simply absent from FormData. */
export function capabilitiesFromForm(formData: FormData): { web: boolean; pdf: boolean } {
  return {
    web: formData.get('capabilityWeb') === 'on',
    pdf: formData.get('capabilityPdf') === 'on',
  };
}
