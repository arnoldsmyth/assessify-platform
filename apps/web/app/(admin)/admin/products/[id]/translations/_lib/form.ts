import type { DomainError } from '@assessify/domain';

/**
 * Shared types + FormData mapping for the translations import form.
 * Controllers only shape input and translate errors — validation of the
 * payload itself ({language, strings}) happens in the translation service
 * (appendix-architecture-layers.md §3a).
 */

export interface TranslationImportIssue {
  /** Path into the upload payload, e.g. `strings.q1.text` or `language`. */
  path: string;
  message: string;
}

export interface TranslationImportFormState {
  status: 'idle' | 'error' | 'success';
  message?: string;
  /** Line-item validation errors from the import schema. */
  issues?: TranslationImportIssue[];
}

export const initialImportFormState: TranslationImportFormState = { status: 'idle' };

export function importStateFromError(error: DomainError): TranslationImportFormState {
  if (error.code === 'translation/validation') {
    const issues = (error.detail?.issues ?? []) as TranslationImportIssue[];
    return {
      status: 'error',
      message: 'The upload failed validation — fix the issues below and re-upload.',
      issues,
    };
  }
  if (error.code === 'translation/language_not_available') {
    const available = (error.detail?.availableLanguages ?? []) as string[];
    return {
      status: 'error',
      message: `${error.message}. Available: ${available.join(', ')}. Add the language to the product first.`,
    };
  }
  return { status: 'error', message: error.message };
}

/** Translation uploads are hand-exported JSON; anything above 2 MB is a mistake. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export type RawImportPayload =
  | { ok: true; payload: unknown }
  | { ok: false; message: string };

/**
 * Pull the upload JSON out of the form: an uploaded `.json` file wins over
 * the paste textarea. Only JSON.parse happens here — the
 * `{language, strings}` shape is the service's job to validate.
 */
export async function readImportPayloadFromForm(formData: FormData): Promise<RawImportPayload> {
  const file = formData.get('file');
  let text: string | null = null;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return { ok: false, message: 'Translations file is too large (2 MB max).' };
    }
    text = await file.text();
  } else {
    const pasted = formData.get('payload');
    if (typeof pasted === 'string' && pasted.trim() !== '') text = pasted;
  }

  if (text === null) {
    return { ok: false, message: 'Provide translations — upload a .json file or paste JSON.' };
  }
  if (text.length > MAX_UPLOAD_BYTES) {
    return { ok: false, message: 'Translations are too large (2 MB max).' };
  }

  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, message: `Not valid JSON: ${reason}` };
  }
}
