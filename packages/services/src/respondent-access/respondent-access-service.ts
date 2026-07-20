import {
  err,
  MAX_FAILED_PIN_ATTEMPTS,
  ok,
  PIN_LOCKOUT_MS,
  RESPONDENT_SESSION_TTL_MS,
  respondentAccessTokenSchema,
  respondentPinSchema,
  type DomainError,
  type RespondentAccessSession,
  type RespondentSessionPayload,
  type RespondentSessionStatus,
  type Result,
} from '@assessify/domain';
import type { PinAttemptStore, RespondentSessionRepository } from '@assessify/repositories';

import type { AuditService } from '../audit';
import type { PinHasher } from './pin-hasher';
import { signSessionPayload, verifySessionPayload } from './session-token';

/**
 * Respondent token+PIN access (C1 — spec 05, patterns 1/2: named invitation).
 *
 * Flow: controller resolves `/a/{token}` via `resolveToken`, collects the
 * 6-digit PIN, calls `verifyPin`; on success this service issues an opaque
 * HMAC-signed session payload which the WEB controller stores in an HttpOnly
 * cookie (services never see cookies — layer rule). 5 failed attempts lock
 * the session for 15 minutes; lockouts are audited.
 *
 * Error hygiene (spec 05): unknown/void tokens return one generic
 * `link_invalid` error with no detail — no leaking whether a token exists.
 * No PII appears in errors, audit detail, or anything a controller might log.
 */

export interface RespondentSessionView {
  sessionId: string;
  status: RespondentSessionStatus;
  /** False only for batch-code sessions (pattern 5) — not served by this flow. */
  pinRequired: boolean;
  language: string | null;
  /** Non-null while PIN entry is locked out. */
  lockedUntil: Date | null;
}

export interface IssuedRespondentSession {
  sessionId: string;
  status: RespondentSessionStatus;
  /** Opaque signed payload for the `resp_session` HttpOnly cookie. */
  sessionToken: string;
  expiresAt: Date;
}

export interface RespondentAccessService {
  /** Look up the session behind an access token (no PIN yet). */
  resolveToken(token: unknown): Promise<Result<RespondentSessionView>>;
  /** Verify the PIN for a token; success issues a signed session payload. */
  verifyPin(token: unknown, pin: unknown): Promise<Result<IssuedRespondentSession>>;
  /** Validate a signed session payload from the cookie (signature + expiry + session existence). */
  validateSessionToken(sessionToken: unknown): Promise<Result<RespondentSessionPayload>>;
}

export interface RespondentAccessConfig {
  /** HMAC-SHA256 key for session payloads — injected via config, never hardcoded. */
  sessionSigningKey: string;
  /** Default: 24h (spec 05). */
  sessionTtlMs?: number;
  /** Default: 5 (spec 05). */
  maxFailedAttempts?: number;
  /** Default: 15 minutes (spec 05). */
  lockoutMs?: number;
}

export interface RespondentAccessServiceDeps {
  sessions: RespondentSessionRepository;
  pinAttempts: PinAttemptStore;
  audit: AuditService;
  pinHasher: PinHasher;
  config: RespondentAccessConfig;
  now?: () => Date;
}

const MIN_SIGNING_KEY_LENGTH = 32;

// Generic, non-leaking errors (spec 05 "no detail leakage").
function linkInvalid(): DomainError {
  return {
    code: 'respondent_access/link_invalid',
    message: 'This link is not valid. Please use the link from your invitation email.',
  };
}

function pinInvalid(attemptsRemaining: number): DomainError {
  return {
    code: 'respondent_access/pin_invalid',
    message: 'That PIN is not correct. Please check your invitation email and try again.',
    detail: { attemptsRemaining },
  };
}

function locked(retryAt: Date): DomainError {
  return {
    code: 'respondent_access/locked',
    message: 'Too many incorrect PIN attempts. Please try again later.',
    detail: { retryAt: retryAt.toISOString() },
  };
}

function sessionInvalid(): DomainError {
  return {
    code: 'respondent_access/session_invalid',
    message: 'Your session is not valid. Please re-enter your PIN.',
  };
}

function sessionExpired(): DomainError {
  return {
    code: 'respondent_access/session_expired',
    message: 'Your session has expired. Please re-enter your PIN.',
  };
}

export function createRespondentAccessService(
  deps: RespondentAccessServiceDeps
): RespondentAccessService {
  const { sessions, pinAttempts, audit, pinHasher } = deps;
  const signingKey = deps.config.sessionSigningKey;
  if (signingKey.length < MIN_SIGNING_KEY_LENGTH) {
    // Misconfiguration is a programmer error — fail loudly at composition time.
    throw new Error(
      `respondent access session signing key must be at least ${MIN_SIGNING_KEY_LENGTH} characters`
    );
  }
  const sessionTtlMs = deps.config.sessionTtlMs ?? RESPONDENT_SESSION_TTL_MS;
  const maxFailedAttempts = deps.config.maxFailedAttempts ?? MAX_FAILED_PIN_ATTEMPTS;
  const lockoutMs = deps.config.lockoutMs ?? PIN_LOCKOUT_MS;
  const now = deps.now ?? (() => new Date());

  /** Active lockout instant, clearing counters when a lockout has lapsed. */
  async function activeLockedUntil(sessionId: string, at: Date): Promise<Date | null> {
    const state = await pinAttempts.get(sessionId);
    if (state.lockedUntil === null) return null;
    if (state.lockedUntil.getTime() > at.getTime()) return state.lockedUntil;
    // Lockout lapsed — fresh start.
    await pinAttempts.clear(sessionId);
    return null;
  }

  async function findByToken(tokenInput: unknown): Promise<RespondentAccessSession | null> {
    const parsed = respondentAccessTokenSchema.safeParse(tokenInput);
    if (!parsed.success) return null;
    return sessions.findByToken(parsed.data);
  }

  return {
    async resolveToken(token) {
      const session = await findByToken(token);
      if (!session) return err(linkInvalid());
      const lockedUntil = await activeLockedUntil(session.id, now());
      return ok({
        sessionId: session.id,
        status: session.status,
        pinRequired: session.pinHash !== null,
        language: session.language,
        lockedUntil,
      });
    },

    async verifyPin(token, pin) {
      const session = await findByToken(token);
      if (!session) return err(linkInvalid());
      // Patterns 1/2 always carry a PIN; a session without one cannot be
      // verified here — same generic error, no detail leakage.
      if (session.pinHash === null) return err(linkInvalid());

      const at = now();
      const lockedUntil = await activeLockedUntil(session.id, at);
      if (lockedUntil !== null) return err(locked(lockedUntil));

      const parsedPin = respondentPinSchema.safeParse(pin);
      // Malformed input can never match — reject without burning an attempt
      // (attempts count real guesses; the format is public knowledge).
      if (!parsedPin.success) {
        const state = await pinAttempts.get(session.id);
        return err(pinInvalid(Math.max(maxFailedAttempts - state.failedAttempts, 0)));
      }

      const matches = await pinHasher.verify(parsedPin.data, session.pinHash);
      if (!matches) {
        const failedAttempts = await pinAttempts.increment(session.id);
        if (failedAttempts >= maxFailedAttempts) {
          const until = new Date(at.getTime() + lockoutMs);
          await pinAttempts.lock(session.id, until);
          const audited = await audit.record(
            { kind: 'respondent', id: session.id },
            'respondent_session.pin_locked',
            { type: 'respondent_session', id: session.id },
            { failedAttempts, lockoutMs, lockedUntil: until.toISOString() }
          );
          if (!audited.ok) return err(audited.error);
          return err(locked(until));
        }
        return err(pinInvalid(maxFailedAttempts - failedAttempts));
      }

      await pinAttempts.clear(session.id);
      const expiresAt = new Date(at.getTime() + sessionTtlMs);
      const sessionToken = await signSessionPayload(signingKey, {
        sessionId: session.id,
        exp: expiresAt.getTime(),
      });
      return ok({ sessionId: session.id, status: session.status, sessionToken, expiresAt });
    },

    async validateSessionToken(sessionToken) {
      if (typeof sessionToken !== 'string' || sessionToken === '') {
        return err(sessionInvalid());
      }
      const payload = await verifySessionPayload(signingKey, sessionToken);
      if (payload === null) return err(sessionInvalid());
      if (payload.exp <= now().getTime()) return err(sessionExpired());
      // The session must still exist — a signed cookie for a deleted session
      // is worthless.
      const session = await sessions.findById(payload.sessionId);
      if (!session) return err(sessionInvalid());
      return ok(payload);
    },
  };
}
