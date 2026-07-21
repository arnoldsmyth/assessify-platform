import type { DomainError, Organization } from '@assessify/domain';

/**
 * Shared types + FormData mapping for the organization create/edit forms
 * (M4). Controllers only map input and translate errors — validation and
 * business rules live in organizationService
 * (appendix-architecture-layers.md §3a). Pure and unit-tested.
 */

export interface OrganizationFormState {
  status: 'idle' | 'error';
  message?: string;
  /** Keyed by zod issue path, e.g. `slug`. */
  fieldErrors?: Record<string, string>;
}

export const initialOrganizationFormState: OrganizationFormState = { status: 'idle' };

export function formStateFromError(error: DomainError): OrganizationFormState {
  if (error.code === 'organization/validation') {
    const issues = (error.detail?.issues ?? []) as { path: string; message: string }[];
    const fieldErrors: Record<string, string> = {};
    for (const issue of issues) {
      if (!(issue.path in fieldErrors)) fieldErrors[issue.path] = issue.message;
    }
    return { status: 'error', message: 'Please fix the highlighted fields.', fieldErrors };
  }
  if (error.code === 'organization/slug_taken') {
    return { status: 'error', message: error.message, fieldErrors: { slug: error.message } };
  }
  return { status: 'error', message: error.message };
}

/** Client-safe view of an organization for prefilling the edit form. */
export interface OrganizationFormValues {
  name: string;
  slug: string;
  settlementEmail: string | null;
  settlementCurrency: string;
}

export function toFormValues(organization: Organization): OrganizationFormValues {
  return {
    name: organization.name,
    slug: organization.slug,
    settlementEmail: organization.settlementEmail,
    settlementCurrency: organization.settlementCurrency,
  };
}

/**
 * Map the form fields onto the service payload. Deliberately does no
 * validation beyond shaping — the service's Zod schemas are the source of
 * truth and their issue paths line up with the input names used here.
 * An empty settlement email clears it (null), matching the nullable schema.
 */
export function parseOrganizationFormData(formData: FormData): unknown {
  const text = (name: string): string | undefined => {
    const value = formData.get(name);
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };

  return {
    name: text('name') ?? '',
    slug: text('slug') ?? '',
    settlementEmail: text('settlementEmail') ?? null,
    settlementCurrency: (text('settlementCurrency') ?? 'EUR').toUpperCase(),
  };
}
