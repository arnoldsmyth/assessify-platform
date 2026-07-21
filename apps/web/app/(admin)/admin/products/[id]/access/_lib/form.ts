import type { DomainError } from '@assessify/domain';

/**
 * Pure state mapping for the client product-access editor (M4). Grants are
 * validated by organizationService (client must belong to the product's
 * org); this only translates its typed errors for the grant form.
 */

export interface AccessFormState {
  status: 'idle' | 'error';
  message?: string;
  /** Keyed by zod issue path, e.g. `clientId`. */
  fieldErrors?: Record<string, string>;
}

export const initialAccessFormState: AccessFormState = { status: 'idle' };

export function accessStateFromError(error: DomainError): AccessFormState {
  if (error.code === 'organization/validation') {
    const issues = (error.detail?.issues ?? []) as { path: string; message: string }[];
    const fieldErrors: Record<string, string> = {};
    for (const issue of issues) {
      if (!(issue.path in fieldErrors)) fieldErrors[issue.path] = issue.message;
    }
    return { status: 'error', message: 'Please fix the highlighted fields.', fieldErrors };
  }
  if (
    error.code === 'organization/client_outside_organization' ||
    error.code === 'organization/client_not_found'
  ) {
    return { status: 'error', message: error.message, fieldErrors: { clientId: error.message } };
  }
  return { status: 'error', message: error.message };
}
