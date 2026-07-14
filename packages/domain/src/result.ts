/**
 * Typed result pattern (03-architecture.md, "Errors"): services return
 * Result<T, DomainError>; controllers map DomainError to HTTP/UI. Expected
 * failures never throw across layer boundaries.
 */
export interface DomainError {
  readonly code: string;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

export type Result<T, E extends DomainError = DomainError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends DomainError>(error: E): Result<never, E> {
  return { ok: false, error };
}
