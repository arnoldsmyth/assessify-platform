import type { DomainError } from '@assessify/domain';

/**
 * Shared form state + error translation for the respondent access flow.
 * Controllers only map service errors to UI-friendly state
 * (appendix-architecture-layers.md §3a) — all rules live in
 * respondentAccessService. Messages stay generic (spec 05: no detail
 * leakage) and never contain PII.
 */

export interface AccessFormState {
  status: 'idle' | 'error' | 'locked';
  message?: string;
  /** ISO instant when PIN entry unlocks (status 'locked'). */
  retryAt?: string;
  /** Guesses left before lockout, when the service reports it. */
  attemptsRemaining?: number;
}

export const initialAccessFormState: AccessFormState = { status: 'idle' };

export function accessStateFromError(error: DomainError): AccessFormState {
  if (error.code === 'respondent_access/locked') {
    const retryAt = typeof error.detail?.retryAt === 'string' ? error.detail.retryAt : undefined;
    return { status: 'locked', message: error.message, retryAt };
  }
  if (error.code === 'respondent_access/pin_invalid') {
    const attemptsRemaining =
      typeof error.detail?.attemptsRemaining === 'number'
        ? error.detail.attemptsRemaining
        : undefined;
    return { status: 'error', message: error.message, attemptsRemaining };
  }
  return { status: 'error', message: error.message };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Pull the access token out of whatever the respondent pasted — the bare
 * token or the full invitation link. Returns null when nothing token-shaped
 * is present.
 */
export function extractAccessToken(input: string): string | null {
  const matches = input.toLowerCase().match(UUID_RE);
  return matches?.at(-1) ?? null;
}
