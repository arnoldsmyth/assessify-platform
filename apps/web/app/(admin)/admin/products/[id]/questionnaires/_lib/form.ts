import type { DomainError } from '@assessify/domain';

/**
 * Shared types + FormData mapping for the questionnaire import form.
 * Controllers only shape input and translate errors — validation of the
 * definition itself happens in the questionnaire version service via
 * @assessify/questionnaire-schema (appendix-architecture-layers.md §3a).
 */

export interface QuestionnaireImportIssue {
  /** Human-readable JSON path from the validator, e.g. `sections[0].questions[2].showIf`. */
  path: string;
  message: string;
}

export interface QuestionnaireImportFormState {
  status: 'idle' | 'error' | 'success';
  message?: string;
  /** Line-item validation errors from the definition validator. */
  issues?: QuestionnaireImportIssue[];
}

export const initialImportFormState: QuestionnaireImportFormState = { status: 'idle' };

export function importStateFromError(error: DomainError): QuestionnaireImportFormState {
  if (
    error.code === 'questionnaire_definition_invalid' ||
    error.code === 'questionnaire_version/validation'
  ) {
    const issues = (error.detail?.issues ?? []) as QuestionnaireImportIssue[];
    return {
      status: 'error',
      message:
        error.code === 'questionnaire_definition_invalid'
          ? 'The definition failed validation — fix the issues below and re-upload.'
          : 'The import request was invalid.',
      issues,
    };
  }
  return { status: 'error', message: error.message };
}

/** Definitions are hand-reviewed JSON; anything above 2 MB is a mistake. */
const MAX_DEFINITION_BYTES = 2 * 1024 * 1024;

export type RawDefinition =
  | { ok: true; definition: unknown }
  | { ok: false; message: string };

/**
 * Pull the definition JSON out of the form: an uploaded `.json` file wins over
 * the paste textarea. Only JSON.parse happens here — schema/semantic
 * validation is the service's job.
 */
export async function readDefinitionFromForm(formData: FormData): Promise<RawDefinition> {
  const file = formData.get('file');
  let text: string | null = null;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_DEFINITION_BYTES) {
      return { ok: false, message: 'Definition file is too large (2 MB max).' };
    }
    text = await file.text();
  } else {
    const pasted = formData.get('definition');
    if (typeof pasted === 'string' && pasted.trim() !== '') text = pasted;
  }

  if (text === null) {
    return { ok: false, message: 'Provide a definition — upload a .json file or paste JSON.' };
  }
  if (text.length > MAX_DEFINITION_BYTES) {
    return { ok: false, message: 'Definition is too large (2 MB max).' };
  }

  try {
    return { ok: true, definition: JSON.parse(text) };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, message: `Not valid JSON: ${reason}` };
  }
}

export function variantFromForm(formData: FormData): string {
  const value = formData.get('variant');
  if (typeof value !== 'string') return 'self';
  const trimmed = value.trim();
  return trimmed === '' ? 'self' : trimmed;
}
