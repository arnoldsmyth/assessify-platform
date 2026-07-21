import { ok, type RespondentAccessSession } from '@assessify/domain';
import {
  createInMemoryPinAttemptStore,
  type RespondentSessionRepository,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import type { PinHasher } from './pin-hasher';
import { createRespondentAccessService } from './respondent-access-service';

const SESSION_ID = '01890000-0000-7000-8000-000000000101';
const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNKNOWN_TOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PIN = '123456';
const WRONG_PIN = '654321';
const SIGNING_KEY = 'unit-test-signing-key-0123456789abcdef';

function fixtureSession(overrides: Partial<RespondentAccessSession> = {}): RespondentAccessSession {
  return {
    id: SESSION_ID,
    orderId: '01890000-0000-7000-8000-000000000201',
    respondentId: '01890000-0000-7000-8000-000000000301',
    token: TOKEN,
    pinHash: `hashed:${PIN}`,
    status: 'invited',
    isFocal: true,
    questionnaireVersionId: '01890000-0000-7000-8000-000000000401',
    language: 'en',
    invitedAt: new Date('2026-07-01T00:00:00Z'),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

/** In-memory fake implementing the repository port (mocks stay inspectable). */
function makeSessionRepo(seed: RespondentAccessSession[]) {
  return {
    findByToken: vi.fn(async (token: string) => seed.find((s) => s.token === token) ?? null),
    findById: vi.fn(async (id: string) => seed.find((s) => s.id === id) ?? null),
    // C2/E1 fulfilment transitions — unused by the access service.
    markStarted: vi.fn(async () => undefined),
    markCompleted: vi.fn(async () => undefined),
    markAwaitingScores: vi.fn(async () => false),
    applyScores: vi.fn(async () => false),
    markReportReady: vi.fn(async () => false),
  } satisfies RespondentSessionRepository;
}

/** Deterministic fake hasher — the real bcrypt provider has its own test. */
const fakeHasher: PinHasher = {
  hash: async (pin) => `hashed:${pin}`,
  verify: async (pin, pinHash) => pinHash === `hashed:${pin}`,
};

function makeAudit(): AuditService {
  return {
    record: vi.fn(async (actor, action, entityRef, detail) =>
      ok({
        id: '01890000-0000-7000-8000-00000000aaaa',
        actor,
        action,
        entityRef,
        detail: detail ?? {},
        createdAt: new Date('2026-07-19T12:00:00Z'),
      })
    ),
    listByEntity: vi.fn(),
  } as unknown as AuditService;
}

function makeService(options: { sessions?: RespondentAccessSession[] } = {}) {
  const sessions = makeSessionRepo(options.sessions ?? [fixtureSession()]);
  const pinAttempts = createInMemoryPinAttemptStore();
  const audit = makeAudit();
  let currentTime = new Date('2026-07-19T10:00:00Z');
  const service = createRespondentAccessService({
    sessions,
    pinAttempts,
    audit,
    pinHasher: fakeHasher,
    config: { sessionSigningKey: SIGNING_KEY },
    now: () => currentTime,
  });
  return {
    service,
    sessions,
    audit,
    advance(ms: number) {
      currentTime = new Date(currentTime.getTime() + ms);
    },
    time() {
      return currentTime;
    },
  };
}

describe('resolveToken', () => {
  it('resolves a known token to a sanitized session view', async () => {
    const { service } = makeService();
    const result = await service.resolveToken(TOKEN);
    expect(result).toEqual(
      ok({
        sessionId: SESSION_ID,
        status: 'invited',
        pinRequired: true,
        language: 'en',
        lockedUntil: null,
      })
    );
  });

  it('accepts tokens with URL noise (case, whitespace)', async () => {
    const { service } = makeService();
    const result = await service.resolveToken(`  ${TOKEN.toUpperCase()}  `);
    expect(result.ok).toBe(true);
  });

  it('returns one generic link_invalid for an unknown token', async () => {
    const { service } = makeService();
    const result = await service.resolveToken(UNKNOWN_TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('respondent_access/link_invalid');
    expect(result.error.detail).toBeUndefined();
  });

  it('rejects a malformed token without touching the repository', async () => {
    const { service, sessions } = makeService();
    const result = await service.resolveToken('not-a-token');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('respondent_access/link_invalid');
    expect(sessions.findByToken).not.toHaveBeenCalled();
  });
});

describe('verifyPin', () => {
  it('issues a signed 24h session payload on the correct PIN', async () => {
    const { service, time } = makeService();
    const result = await service.verifyPin(TOKEN, PIN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe(SESSION_ID);
    expect(result.value.status).toBe('invited');
    expect(result.value.expiresAt.getTime()).toBe(time().getTime() + 24 * 60 * 60 * 1000);

    const validated = await service.validateSessionToken(result.value.sessionToken);
    expect(validated).toEqual(
      ok({ sessionId: SESSION_ID, exp: result.value.expiresAt.getTime() })
    );
  });

  it('returns generic pin_invalid with attempts remaining on a wrong PIN', async () => {
    const { service } = makeService();
    const first = await service.verifyPin(TOKEN, WRONG_PIN);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.code).toBe('respondent_access/pin_invalid');
    expect(first.error.detail).toEqual({ attemptsRemaining: 4 });

    const second = await service.verifyPin(TOKEN, WRONG_PIN);
    if (second.ok) return;
    expect(second.error.detail).toEqual({ attemptsRemaining: 3 });
  });

  it('does not burn an attempt on malformed PIN input', async () => {
    const { service } = makeService();
    const malformed = await service.verifyPin(TOKEN, 'abc');
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.error.code).toBe('respondent_access/pin_invalid');
    expect(malformed.error.detail).toEqual({ attemptsRemaining: 5 });
  });

  it('locks after 5 failures and records an audit event', async () => {
    const { service, audit, time } = makeService();
    for (let i = 0; i < 4; i += 1) {
      await service.verifyPin(TOKEN, WRONG_PIN);
    }
    const fifth = await service.verifyPin(TOKEN, WRONG_PIN);
    expect(fifth.ok).toBe(false);
    if (fifth.ok) return;
    expect(fifth.error.code).toBe('respondent_access/locked');
    const retryAt = new Date(time().getTime() + 15 * 60 * 1000).toISOString();
    expect(fifth.error.detail).toEqual({ retryAt });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'respondent', id: SESSION_ID },
      'respondent_session.pin_locked',
      { type: 'respondent_session', id: SESSION_ID },
      { failedAttempts: 5, lockoutMs: 15 * 60 * 1000, lockedUntil: retryAt }
    );
  });

  it('rejects even the correct PIN while locked', async () => {
    const { service } = makeService();
    for (let i = 0; i < 5; i += 1) {
      await service.verifyPin(TOKEN, WRONG_PIN);
    }
    const attempt = await service.verifyPin(TOKEN, PIN);
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.error.code).toBe('respondent_access/locked');
  });

  it('reports the lockout via resolveToken and clears it once it lapses', async () => {
    const { service, advance } = makeService();
    for (let i = 0; i < 5; i += 1) {
      await service.verifyPin(TOKEN, WRONG_PIN);
    }
    const lockedView = await service.resolveToken(TOKEN);
    if (!lockedView.ok) return;
    expect(lockedView.value.lockedUntil).not.toBeNull();

    advance(15 * 60 * 1000 + 1);
    const unlockedView = await service.resolveToken(TOKEN);
    if (!unlockedView.ok) return;
    expect(unlockedView.value.lockedUntil).toBeNull();

    const result = await service.verifyPin(TOKEN, PIN);
    expect(result.ok).toBe(true);
  });

  it('resets the failure counter after a successful verification', async () => {
    const { service } = makeService();
    await service.verifyPin(TOKEN, WRONG_PIN);
    await service.verifyPin(TOKEN, WRONG_PIN);
    await service.verifyPin(TOKEN, PIN);

    const afterReset = await service.verifyPin(TOKEN, WRONG_PIN);
    if (afterReset.ok) return;
    expect(afterReset.error.detail).toEqual({ attemptsRemaining: 4 });
  });

  it('returns generic link_invalid for an unknown token', async () => {
    const { service } = makeService();
    const result = await service.verifyPin(UNKNOWN_TOKEN, PIN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('respondent_access/link_invalid');
  });

  it('returns generic link_invalid for a session without a PIN hash', async () => {
    const { service } = makeService({ sessions: [fixtureSession({ pinHash: null })] });
    const result = await service.verifyPin(TOKEN, PIN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('respondent_access/link_invalid');
  });
});

describe('validateSessionToken', () => {
  async function issuedToken(ctx: ReturnType<typeof makeService>) {
    const result = await ctx.service.verifyPin(TOKEN, PIN);
    if (!result.ok) throw new Error('expected PIN verification to succeed');
    return result.value.sessionToken;
  }

  it('rejects a missing or non-string cookie value', async () => {
    const { service } = makeService();
    for (const value of [undefined, null, '', 42]) {
      const result = await service.validateSessionToken(value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('respondent_access/session_invalid');
    }
  });

  it('rejects a tampered payload', async () => {
    const ctx = makeService();
    const token = await issuedToken(ctx);
    const [version, body, signature] = token.split('.');
    const tampered = `${version}.${body}x.${signature}`;
    const result = await ctx.service.validateSessionToken(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('respondent_access/session_invalid');
  });

  it('rejects a token signed with a different key', async () => {
    const ctx = makeService();
    const token = await issuedToken(ctx);
    const otherService = createRespondentAccessService({
      sessions: makeSessionRepo([fixtureSession()]),
      pinAttempts: createInMemoryPinAttemptStore(),
      audit: makeAudit(),
      pinHasher: fakeHasher,
      config: { sessionSigningKey: 'another-key-another-key-another-key!' },
    });
    const result = await otherService.validateSessionToken(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('respondent_access/session_invalid');
  });

  it('rejects an expired session payload', async () => {
    const ctx = makeService();
    const token = await issuedToken(ctx);
    ctx.advance(24 * 60 * 60 * 1000 + 1);
    const result = await ctx.service.validateSessionToken(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('respondent_access/session_expired');
  });

  it('rejects a valid signature whose session no longer exists', async () => {
    const ctx = makeService();
    const token = await issuedToken(ctx);
    ctx.sessions.findById.mockResolvedValue(null);
    const result = await ctx.service.validateSessionToken(token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('respondent_access/session_invalid');
  });
});

describe('configuration', () => {
  it('refuses to construct with a short signing key', () => {
    expect(() =>
      createRespondentAccessService({
        sessions: makeSessionRepo([]),
        pinAttempts: createInMemoryPinAttemptStore(),
        audit: makeAudit(),
        pinHasher: fakeHasher,
        config: { sessionSigningKey: 'too-short' },
      })
    ).toThrow(/signing key/);
  });
});
