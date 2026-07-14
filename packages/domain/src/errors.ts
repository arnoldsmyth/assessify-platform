import type { DomainError } from './result';

/** Build a typed domain error (03 — Errors). */
export function domainError(
  code: string,
  message: string,
  detail?: Record<string, unknown>
): DomainError {
  return detail === undefined ? { code, message } : { code, message, detail };
}

/**
 * Authorization failure (spec 05): every service-level permission check that
 * fails returns this. API surfaces it as 403, web as a friendly message.
 */
export function forbiddenError(
  message = 'You do not have permission to perform this action.',
  detail?: Record<string, unknown>
): DomainError {
  return domainError('forbidden', message, detail);
}

/** No authenticated caller where one is required. API surfaces it as 401. */
export function unauthenticatedError(
  message = 'Authentication is required.',
  detail?: Record<string, unknown>
): DomainError {
  return domainError('unauthenticated', message, detail);
}
