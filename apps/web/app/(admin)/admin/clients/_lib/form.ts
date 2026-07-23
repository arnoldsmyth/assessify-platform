import type { Client, DomainError } from '@assessify/domain';

/**
 * Shared types + FormData mapping for the client create/edit forms (O1).
 * Controllers only map input and translate errors — validation and business
 * rules live in clientService (appendix-architecture-layers.md §3a). Pure
 * and unit-tested.
 */

export interface ClientFormState {
  status: 'idle' | 'error';
  message?: string;
  /** Keyed by zod issue path, e.g. `billingEmail`. */
  fieldErrors?: Record<string, string>;
}

export const initialClientFormState: ClientFormState = { status: 'idle' };

export function formStateFromError(error: DomainError): ClientFormState {
  if (error.code === 'client/validation') {
    const issues = (error.detail?.issues ?? []) as { path: string; message: string }[];
    const fieldErrors: Record<string, string> = {};
    for (const issue of issues) {
      if (!(issue.path in fieldErrors)) fieldErrors[issue.path] = issue.message;
    }
    return { status: 'error', message: 'Please fix the highlighted fields.', fieldErrors };
  }
  if (error.code === 'client/organization_not_found') {
    return {
      status: 'error',
      message: error.message,
      fieldErrors: { organizationId: error.message },
    };
  }
  return { status: 'error', message: error.message };
}

/** Client-safe view of a client for prefilling the edit form. */
export interface ClientFormValues {
  name: string;
  billingEmail: string | null;
  defaultCurrency: string;
  timezone: string;
}

export function toFormValues(client: Client): ClientFormValues {
  return {
    name: client.name,
    billingEmail: client.billingEmail,
    defaultCurrency: client.defaultCurrency,
    timezone: client.timezone,
  };
}

/**
 * Map the form fields onto the service payload. Deliberately does no
 * validation beyond shaping — the service's Zod schemas are the source of
 * truth and their issue paths line up with the input names used here.
 * `organizationId` is only included when the form actually rendered it (the
 * create form's org picker/hidden field) — the update schema is `.strict()`
 * and org reassignment is not part of this CRUD surface.
 */
export function parseClientFormData(formData: FormData): unknown {
  const text = (name: string): string | undefined => {
    const value = formData.get(name);
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  return {
    ...(formData.has('organizationId') ? { organizationId: text('organizationId') ?? '' } : {}),
    name: text('name') ?? '',
    billingEmail: text('billingEmail') ?? null,
    defaultCurrency: (text('defaultCurrency') ?? 'EUR').toUpperCase(),
    timezone: text('timezone') ?? 'Europe/Dublin',
  };
}
