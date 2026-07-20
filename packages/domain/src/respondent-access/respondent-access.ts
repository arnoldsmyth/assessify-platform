import { z } from 'zod';

/**
 * Respondent access domain types (docs/spec/05-roles-and-access.md,
 * "Respondent access"). Covers access patterns 1/2 (named invitation:
 * `/a/{token}` + 6-digit PIN). Respondent access is deliberately NOT a
 * Better Auth account — successful token+PIN verification yields a signed,
 * short-lived session payload the web controller stores in an HttpOnly
 * cookie.
 *
 * Hard rule (spec 05): the token is the only URL secret and is opaque
 * (UUIDv4). No PII ever appears in URLs or logs.
 */

// ---------------------------------------------------------------------------
// Token & PIN formats
// ---------------------------------------------------------------------------

/**
 * Access token: UUIDv4 random (not v7 — no time-ordering leakage), never
 * reused. Lowercased on parse so URL casing never matters.
 */
export const respondentAccessTokenSchema = z
  .string()
  .trim()
  .toLowerCase()
  .uuid('Must be an access token UUID');

export const RESPONDENT_PIN_LENGTH = 6;

/** 6 numeric digits, generated per session, bcrypt-hashed at rest (spec 05). */
export const respondentPinSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, `PIN must be exactly ${RESPONDENT_PIN_LENGTH} digits`);

// ---------------------------------------------------------------------------
// Lockout policy (spec 05: "5 failed attempts → 15-minute lockout")
// ---------------------------------------------------------------------------

export const MAX_FAILED_PIN_ATTEMPTS = 5;
export const PIN_LOCKOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Respondent session cookie policy (spec 05: `resp_session`, 24h)
// ---------------------------------------------------------------------------

/** Cookie name the web controller uses for the signed session payload. */
export const RESPONDENT_SESSION_COOKIE = 'resp_session';

/** Signed session payload lifetime: 24h, then PIN re-entry (spec 05). */
export const RESPONDENT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Claims inside the signed respondent session payload. Deliberately minimal:
 * the session id and an absolute expiry (epoch milliseconds, UTC). Never any
 * PII — everything else is looked up server-side by session id.
 */
export const respondentSessionPayloadSchema = z.object({
  sessionId: z.string().uuid(),
  /** Absolute expiry, epoch milliseconds UTC. */
  exp: z.number().int().positive(),
});
export type RespondentSessionPayload = z.infer<typeof respondentSessionPayloadSchema>;

// ---------------------------------------------------------------------------
// Session entity (subset of `respondent_sessions` relevant to access)
// ---------------------------------------------------------------------------

/** Mirrors the `session_status` pg enum (spec 04) — do not reorder. */
export const respondentSessionStatuses = [
  'created',
  'invited',
  'started',
  'completed',
  'awaiting_scores',
  'scored',
  'report_ready',
] as const;
export const respondentSessionStatusSchema = z.enum(respondentSessionStatuses);
export type RespondentSessionStatus = z.infer<typeof respondentSessionStatusSchema>;

/**
 * The access-relevant projection of one `respondent_sessions` row, mapped to
 * the domain by the repository. Contains the PIN hash for in-service
 * verification — services must never return it to callers (the sanitized
 * views below exist for that).
 */
export const respondentAccessSessionSchema = z.object({
  id: z.string().uuid(),
  orderId: z.string().uuid(),
  /** Null until self-registration (patterns 3/5). */
  respondentId: z.string().uuid().nullable(),
  /** The URL secret; distinct from id. */
  token: respondentAccessTokenSchema,
  /** bcrypt hash; null for batch-code sessions (pattern 5). */
  pinHash: z.string().min(1).nullable(),
  status: respondentSessionStatusSchema,
  isFocal: z.boolean(),
  questionnaireVersionId: z.string().uuid(),
  language: z.string().nullable(),
  invitedAt: z.date().nullable(),
  startedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
});
export type RespondentAccessSession = z.infer<typeof respondentAccessSessionSchema>;
