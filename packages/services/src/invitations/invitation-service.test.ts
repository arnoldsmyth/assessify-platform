import { describe, expect, it } from 'vitest';
import {
  ok,
  err,
  type CallerContext,
  type DomainError,
  type JobPayload,
  type Order,
  type Product,
  type Result,
} from '@assessify/domain';
import type { EnqueueOptions, JobQueue } from '@assessify/adapters';
import type {
  ActiveCustomDomain,
  InvitationSessionRecord,
  InvitationSessionRepository,
} from '@assessify/repositories';

import type { AuditService } from '../audit';
import type { NotificationService } from '../notifications';
import { createBcryptPinHasher, type PinHasher } from '../respondent-access';
import { createInvitationService, type InvitationServiceDeps } from './invitation-service';

/**
 * Invitation service tests (D5). Repos/services are in-memory doubles per
 * package convention; the PIN roundtrip test uses the REAL bcrypt hasher so
 * the at-rest hash provably verifies through C1's `PinHasher` port.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORDER_ID = '01890a5d-ac96-774b-bcce-b302099a0001';
const PRODUCT_ID = '01890a5d-ac96-774b-bcce-b302099a0002';
const CLIENT_ID = '01890a5d-ac96-774b-bcce-b302099a0003';
const QV_ID = '01890a5d-ac96-774b-bcce-b302099a0004';
const SESSION_A = '01890a5d-ac96-774b-bcce-b302099a000a';
const SESSION_B = '01890a5d-ac96-774b-bcce-b302099a000b';
const TOKEN_A = '9b2fbe45-9c17-4bd6-a0f5-2f4576a5c9a1';
const TOKEN_B = '9b2fbe45-9c17-4bd6-a0f5-2f4576a5c9b2';
const NOTIFICATION_ID = '01890a5d-ac96-774b-bcce-b302099a00ff';

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    reference: 'ORD-00042',
    type: 'bulk_named',
    status: 'approved',
    clientId: CLIENT_ID,
    productId: PRODUCT_ID,
    questionnaireVersionId: QV_ID,
    reportTemplateVersionId: null,
    reportLanguage: 'en',
    reportModel: 'individual',
    currency: 'EUR',
    subtotal: 10_000,
    discountTotal: 0,
    total: 10_000,
    paymentProvider: 'offline',
    entitlementId: null,
    notificationPolicy: null,
    suppressNotifications: false,
    expectedRespondents: null,
    pageSize: null,
    isTest: false,
    relatedOrderId: null,
    placedByUserId: null,
    placedVia: 'admin',
    errorDetail: null,
    source: 'native',
    legacyId: null,
    approvedAt: new Date('2026-07-01T10:00:00Z'),
    sentAt: null,
    completedAt: null,
    createdAt: new Date('2026-07-01T09:00:00Z'),
    updatedAt: new Date('2026-07-01T10:00:00Z'),
    ...overrides,
  };
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    slug: 'pro-d',
    name: 'Pro-D',
    status: 'active',
    branding: {},
    defaultLanguage: 'en',
    availableLanguages: ['en', 'de'],
    externalIds: {},
    scoringConfig: { mode: 'sync_internal', timeoutSeconds: 30, maxAttempts: 3 },
    notificationDefaults: {},
    reportPageSizeDefault: 'a4',
    retailEnabled: false,
    retailPrice: null,
    retailCurrency: null,
    connectedStripeAccountId: null,
    revenueSplitPct: null,
    royaltyPolicy: null,
    timezone: 'Europe/Dublin',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeSession(overrides: Partial<InvitationSessionRecord> = {}): InvitationSessionRecord {
  return {
    id: SESSION_A,
    orderId: ORDER_ID,
    token: TOKEN_A,
    status: 'created',
    language: 'en',
    invitedAt: null,
    respondent: { email: 'ada@example.com', firstName: 'Ada' },
    ...overrides,
  };
}

const fullPermissions = {
  products: 'all' as const,
  groups: 'all' as const,
  canPlaceOrders: true,
  canViewResults: true,
  canReleaseReports: true,
};

const superAdmin: CallerContext = {
  kind: 'user',
  id: '01890a5d-ac96-774b-bcce-b302099a0100',
  roles: [{ role: 'super_admin', productId: null, clientId: null, permissions: fullPermissions }],
};

const otherClientAdmin: CallerContext = {
  kind: 'user',
  id: '01890a5d-ac96-774b-bcce-b302099a0101',
  roles: [
    {
      role: 'client_admin',
      productId: null,
      clientId: '01890a5d-ac96-774b-bcce-b302099a0999',
      permissions: fullPermissions,
    },
  ],
};

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function createFakeSessionRepo(initial: InvitationSessionRecord[]) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]));
  const pinHashes = new Map<string, string | null>();
  const repo: InvitationSessionRepository = {
    async listByOrder(orderId) {
      return [...rows.values()].filter((row) => row.orderId === orderId);
    },
    async markInvited(sessionId, pinHash, at) {
      const row = rows.get(sessionId);
      if (!row || row.status !== 'created') return false;
      rows.set(sessionId, { ...row, status: 'invited', invitedAt: at });
      pinHashes.set(sessionId, pinHash);
      return true;
    },
    async replacePinHash(sessionId, pinHash) {
      const row = rows.get(sessionId);
      if (!row || (row.status !== 'invited' && row.status !== 'started')) return false;
      pinHashes.set(sessionId, pinHash);
      return true;
    },
  };
  return { repo, rows, pinHashes };
}

interface TransitionCall {
  caller: CallerContext;
  orderId: string;
  input: unknown;
}

function createFakeOrderService(result?: () => Result<Order, DomainError>) {
  const calls: TransitionCall[] = [];
  return {
    calls,
    orderService: {
      async transition(caller: CallerContext, orderId: string, input: unknown) {
        calls.push({ caller, orderId, input });
        return result ? result() : ok(makeOrder({ status: 'sent' }));
      },
    },
  };
}

interface SentNotification {
  kind: string;
  to: string;
  data: Record<string, unknown>;
  language: string;
  sender: { from: { name: string; address: string } };
  refs: { orderId?: string; sessionId?: string };
}

function createFakeNotifications(failFor?: (to: string) => boolean) {
  const sent: SentNotification[] = [];
  const notifications: Pick<NotificationService, 'send'> = {
    async send(input: unknown) {
      const request = input as SentNotification;
      if (failFor?.(request.to)) {
        return err({ code: 'notification/enqueue_failed', message: 'queue down' });
      }
      sent.push(request);
      return ok({ notificationId: NOTIFICATION_ID, status: 'queued' as const });
    },
  };
  return { notifications, sent };
}

function createFakeAudit() {
  const events: { actor: unknown; action: string; entity: unknown; detail?: unknown }[] = [];
  const audit: AuditService = {
    async record(actor, action, entity, detail) {
      events.push({ actor, action, entity, detail });
      return ok({
        id: 'audit-1',
        actor: actor as never,
        action,
        entityRef: entity as never,
        detail: (detail ?? null) as never,
        createdAt: new Date(),
      } as never);
    },
    async listByEntity() {
      return ok({ items: [], total: 0 } as never);
    },
  };
  return { audit, events };
}

function createFakeQueue() {
  const calls: { jobName: string; payload: unknown; options: EnqueueOptions | undefined }[] = [];
  const queue: JobQueue = {
    async enqueue(jobName, payload, options) {
      calls.push({ jobName, payload, options });
      return { jobId: options?.idempotencyKey ?? jobName };
    },
  };
  return { queue, calls };
}

/** Deterministic, cheap hasher for tests that don't exercise bcrypt itself. */
const fakeHasher: PinHasher = {
  async hash(pin) {
    return `hashed:${pin}`;
  },
  async verify(pin, pinHash) {
    return pinHash === `hashed:${pin}`;
  },
};

interface BuildOptions {
  order?: Order;
  product?: Product;
  sessions?: InvitationSessionRecord[];
  customDomains?: ActiveCustomDomain[];
  orderServiceResult?: () => Result<Order, DomainError>;
  notificationFailFor?: (to: string) => boolean;
  pinHasher?: PinHasher;
  alertRecipients?: string[];
  queue?: ReturnType<typeof createFakeQueue>;
}

function buildService(options: BuildOptions = {}) {
  const order = options.order ?? makeOrder();
  const product = options.product ?? makeProduct();
  const sessionRepo = createFakeSessionRepo(
    options.sessions ?? [
      makeSession(),
      makeSession({
        id: SESSION_B,
        token: TOKEN_B,
        language: 'de',
        respondent: { email: 'grace@example.com', firstName: 'Grace' },
      }),
    ]
  );
  const orderServiceBundle = createFakeOrderService(options.orderServiceResult);
  const notificationBundle = createFakeNotifications(options.notificationFailFor);
  const auditBundle = createFakeAudit();
  const queueBundle = options.queue ?? createFakeQueue();

  const deps: InvitationServiceDeps = {
    sessions: sessionRepo.repo,
    orders: { findById: async (id) => (id === order.id ? order : null) },
    orderService: orderServiceBundle.orderService,
    products: { findById: async (id) => (id === product.id ? product : null) },
    customDomains: {
      findActiveByProductId: async () => options.customDomains ?? [],
    },
    notifications: notificationBundle.notifications,
    pinHasher: options.pinHasher ?? fakeHasher,
    audit: auditBundle.audit,
    queue: queueBundle.queue,
    config: {
      slugBaseDomain: 'assessify.ie',
      platformSender: { name: 'Assessify', address: 'no-reply@assessify.ie' },
      ...(options.alertRecipients !== undefined && { alertRecipients: options.alertRecipients }),
    },
  };
  const service = createInvitationService(deps);
  return {
    service,
    order,
    product,
    ...sessionRepo,
    transitions: orderServiceBundle.calls,
    sent: notificationBundle.sent,
    auditEvents: auditBundle.events,
    enqueued: queueBundle.calls,
  };
}

function dispatchPayload(
  overrides: Partial<JobPayload<'invitations.dispatch'>> = {}
): JobPayload<'invitations.dispatch'> {
  return { orderId: ORDER_ID, resend: false, requestedByUserId: null, ...overrides };
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe('invitationService.dispatch (first dispatch)', () => {
  it('invites every created session: PIN hashed+stored, email queued with link+PIN, order → sent', async () => {
    const ctx = buildService();
    const result = await ctx.service.dispatch(dispatchPayload());

    expect(result).toMatchObject({
      ok: true,
      value: { sent: 2, suppressed: 0, skipped: 0, failed: [], orderTransition: 'invitations_sent' },
    });
    // Sessions marked invited with a stored hash matching the emailed PIN.
    expect(ctx.rows.get(SESSION_A)?.status).toBe('invited');
    expect(ctx.rows.get(SESSION_B)?.status).toBe('invited');
    const emailA = ctx.sent.find((message) => message.to === 'ada@example.com');
    expect(emailA).toBeDefined();
    const pinA = emailA?.data['pin'];
    expect(pinA).toMatch(/^\d{6}$/);
    expect(ctx.pinHashes.get(SESSION_A)).toBe(`hashed:${String(pinA)}`);
    // Link: white-label slug host + the session token; no PII in the URL.
    expect(emailA?.data['entryUrl']).toBe(`https://pro-d.assessify.ie/a/${TOKEN_A}`);
    // Session language wins over the order report language.
    const emailB = ctx.sent.find((message) => message.to === 'grace@example.com');
    expect(emailB?.language).toBe('de');
    // No branding.emailFrom → platform sender.
    expect(emailA?.sender.from.address).toBe('no-reply@assessify.ie');
    expect(emailA?.refs).toEqual({ orderId: ORDER_ID, sessionId: SESSION_A });
    // Order machine driven through the order service as system.
    expect(ctx.transitions).toHaveLength(1);
    expect(ctx.transitions[0]).toMatchObject({
      orderId: ORDER_ID,
      caller: { kind: 'system' },
      input: { event: 'invitations_sent' },
    });
    // Audit summary carries counts and ids only — never emails or PINs.
    const audit = ctx.auditEvents.find((event) => event.action === 'invitation.dispatch_completed');
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toContain('ada@example.com');
    expect(JSON.stringify(audit)).not.toContain(String(pinA));
  });

  it('uses product branding.emailFrom as the sender when configured (spec 13)', async () => {
    const ctx = buildService({
      product: makeProduct({
        branding: { emailFrom: { name: 'Pro-D Assessments', address: 'hello@pro-d.com' } },
      }),
    });
    await ctx.service.dispatch(dispatchPayload());
    expect(ctx.sent[0]?.sender.from).toEqual({
      name: 'Pro-D Assessments',
      address: 'hello@pro-d.com',
    });
  });

  it('builds links on the client-scoped custom domain when one is active (spec 11)', async () => {
    const ctx = buildService({
      customDomains: [
        { hostname: 'assessments.pro-d.com', productId: PRODUCT_ID, clientId: null },
        { hostname: 'talent.acme.com', productId: PRODUCT_ID, clientId: CLIENT_ID },
      ],
    });
    await ctx.service.dispatch(dispatchPayload());
    expect(ctx.sent[0]?.data['entryUrl']).toBe(`https://talent.acme.com/a/${TOKEN_A}`);
  });

  it('is idempotent: already-invited sessions are skipped, no emails, no PIN change', async () => {
    const ctx = buildService({
      sessions: [
        makeSession({ status: 'invited', invitedAt: new Date() }),
        makeSession({
          id: SESSION_B,
          token: TOKEN_B,
          status: 'started',
          respondent: { email: 'grace@example.com', firstName: 'Grace' },
        }),
      ],
    });
    const result = await ctx.service.dispatch(dispatchPayload());
    expect(result).toMatchObject({ ok: true, value: { sent: 0, skipped: 2, failed: [] } });
    expect(ctx.sent).toHaveLength(0);
    expect(ctx.pinHashes.size).toBe(0);
    // Order still approved (e.g. crash before the transition) → completes to sent.
    expect(ctx.transitions[0]).toMatchObject({ input: { event: 'invitations_sent' } });
  });

  it('replays as a no-op when the order has moved past dispatch', async () => {
    const ctx = buildService({ order: makeOrder({ status: 'cancelled' }) });
    const result = await ctx.service.dispatch(dispatchPayload());
    expect(result).toMatchObject({ ok: true, value: { sent: 0 } });
    expect(ctx.transitions).toHaveLength(0);
    expect(ctx.sent).toHaveLength(0);
  });

  it('transitions to email_error (+ super-admin alert) when nothing could be sent', async () => {
    const ctx = buildService({
      notificationFailFor: () => true,
      alertRecipients: ['admin@assessify.ie'],
    });
    const result = await ctx.service.dispatch(dispatchPayload());
    expect(result).toMatchObject({
      ok: true,
      value: { sent: 0, failed: [{ sessionId: SESSION_A }, { sessionId: SESSION_B }] },
    });
    expect(ctx.transitions[0]).toMatchObject({
      input: {
        event: 'invitation_failed',
        errorDetail: {
          reason: 'invitation_dispatch_failed',
          failedSessionIds: [SESSION_A, SESSION_B],
        },
      },
    });
    // Alert attempted through the same notification path (it also fails here,
    // which must not fail the dispatch Result).
    expect(result.ok).toBe(true);
  });

  it('records a failure for sessions without a respondent email, still sending the rest', async () => {
    const ctx = buildService({
      sessions: [
        makeSession({ respondent: null }),
        makeSession({
          id: SESSION_B,
          token: TOKEN_B,
          respondent: { email: 'grace@example.com', firstName: 'Grace' },
        }),
      ],
    });
    const result = await ctx.service.dispatch(dispatchPayload());
    expect(result).toMatchObject({
      ok: true,
      value: {
        sent: 1,
        failed: [{ sessionId: SESSION_A, code: 'missing_email' }],
        orderTransition: 'invitations_sent',
      },
    });
  });

  it('silent mode (suppress_notifications): marks invited without PIN or email, order → sent', async () => {
    const ctx = buildService({ order: makeOrder({ suppressNotifications: true }) });
    const result = await ctx.service.dispatch(dispatchPayload());
    expect(result).toMatchObject({
      ok: true,
      value: { sent: 0, suppressed: 2, orderTransition: 'invitations_sent' },
    });
    expect(ctx.sent).toHaveLength(0);
    expect(ctx.pinHashes.get(SESSION_A)).toBeNull();
    expect(ctx.rows.get(SESSION_A)?.status).toBe('invited');
  });

  it('tolerates a concurrent transition (order/illegal_transition) as already-applied', async () => {
    const ctx = buildService({
      orderServiceResult: () =>
        err({ code: 'order/illegal_transition', message: 'already sent' }),
    });
    const result = await ctx.service.dispatch(dispatchPayload());
    expect(result).toMatchObject({ ok: true, value: { sent: 2, orderTransition: null } });
  });
});

// ---------------------------------------------------------------------------
// resend
// ---------------------------------------------------------------------------

describe('invitationService.dispatch (resend mode)', () => {
  const invitedSessions = () => [
    makeSession({ status: 'invited', invitedAt: new Date() }),
    makeSession({
      id: SESSION_B,
      token: TOKEN_B,
      status: 'completed',
      respondent: { email: 'grace@example.com', firstName: 'Grace' },
    }),
  ];

  it('regenerates the PIN for the targeted session and emails it (same token)', async () => {
    const ctx = buildService({
      order: makeOrder({ status: 'sent', sentAt: new Date() }),
      sessions: invitedSessions(),
    });
    const result = await ctx.service.dispatch(
      dispatchPayload({ resend: true, sessionIds: [SESSION_A] })
    );
    expect(result).toMatchObject({ ok: true, value: { mode: 'resend', sent: 1, failed: [] } });
    const pin = ctx.sent[0]?.data['pin'];
    expect(pin).toMatch(/^\d{6}$/);
    expect(ctx.pinHashes.get(SESSION_A)).toBe(`hashed:${String(pin)}`);
    // Same token in the link — only the PIN rotates (spec 05).
    expect(ctx.sent[0]?.data['entryUrl']).toBe(`https://pro-d.assessify.ie/a/${TOKEN_A}`);
    // No order transition on resend.
    expect(ctx.transitions).toHaveLength(0);
    const audit = ctx.auditEvents.find((event) => event.action === 'invitation.resent');
    expect(audit).toMatchObject({ detail: { sessionIds: [SESSION_A] } });
  });

  it('skips completed sessions on a whole-order resend', async () => {
    const ctx = buildService({
      order: makeOrder({ status: 'sent', sentAt: new Date() }),
      sessions: invitedSessions(),
    });
    const result = await ctx.service.dispatch(dispatchPayload({ resend: true }));
    expect(result).toMatchObject({ ok: true, value: { sent: 1 } });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]?.to).toBe('ada@example.com');
  });

  it('refuses resend for silent-mode orders (permanent)', async () => {
    const ctx = buildService({
      order: makeOrder({ status: 'sent', suppressNotifications: true }),
      sessions: invitedSessions(),
    });
    const result = await ctx.service.dispatch(dispatchPayload({ resend: true }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invitation/notifications_suppressed', detail: { permanent: true } },
    });
  });
});

// ---------------------------------------------------------------------------
// PIN roundtrip against C1's verifier (real bcrypt)
// ---------------------------------------------------------------------------

describe('PIN generation/hash roundtrip (C1 compatibility)', () => {
  it('the emailed PIN verifies against the stored hash via the bcrypt PinHasher port', async () => {
    // Low cost keeps the suite fast; the format is identical to production.
    const bcryptHasher = createBcryptPinHasher(4);
    const ctx = buildService({
      sessions: [makeSession()],
      pinHasher: bcryptHasher,
    });
    await ctx.service.dispatch(dispatchPayload());

    const pin = String(ctx.sent[0]?.data['pin']);
    const storedHash = ctx.pinHashes.get(SESSION_A);
    expect(pin).toMatch(/^\d{6}$/);
    expect(storedHash).toBeTruthy();
    await expect(bcryptHasher.verify(pin, String(storedHash))).resolves.toBe(true);
    await expect(
      bcryptHasher.verify(pin === '000000' ? '000001' : '000000', String(storedHash))
    ).resolves.toBe(false);

    // Resend rotates the PIN: the old one stops verifying, the new one works.
    ctx.rows.set(SESSION_A, { ...makeSession(), status: 'invited' });
    await ctx.service.dispatch(dispatchPayload({ resend: true, sessionIds: [SESSION_A] }));
    const newPin = String(ctx.sent[1]?.data['pin']);
    const newHash = String(ctx.pinHashes.get(SESSION_A));
    await expect(bcryptHasher.verify(newPin, newHash)).resolves.toBe(true);
    if (newPin !== pin) {
      await expect(bcryptHasher.verify(pin, newHash)).resolves.toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// request paths (web actions)
// ---------------------------------------------------------------------------

describe('invitationService.requestDispatch', () => {
  it('enqueues invitations.dispatch for an approved order (deduped per order)', async () => {
    const ctx = buildService();
    const result = await ctx.service.requestDispatch(superAdmin, { orderId: ORDER_ID });
    expect(result).toMatchObject({ ok: true, value: { jobId: `invitations.dispatch:${ORDER_ID}` } });
    expect(ctx.enqueued[0]).toMatchObject({
      jobName: 'invitations.dispatch',
      payload: { orderId: ORDER_ID, resend: false, requestedByUserId: superAdmin.id },
      options: { idempotencyKey: `invitations.dispatch:${ORDER_ID}` },
    });
    expect(
      ctx.auditEvents.some((event) => event.action === 'invitation.dispatch_requested')
    ).toBe(true);
  });

  it('rejects orders not in approved', async () => {
    const ctx = buildService({ order: makeOrder({ status: 'pending' }) });
    const result = await ctx.service.requestDispatch(superAdmin, { orderId: ORDER_ID });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invitation/order_not_dispatchable' },
    });
  });

  it("hides the order from another client's admin (spec 05: UUIDs are never enough)", async () => {
    const ctx = buildService();
    const result = await ctx.service.requestDispatch(otherClientAdmin, { orderId: ORDER_ID });
    expect(result).toMatchObject({ ok: false, error: { code: 'invitation/order_not_found' } });
    expect(ctx.enqueued).toHaveLength(0);
  });
});

describe('invitationService.requestResend', () => {
  it('enqueues a per-session resend job', async () => {
    const ctx = buildService({
      order: makeOrder({ status: 'sent', sentAt: new Date() }),
      sessions: [makeSession({ status: 'invited', invitedAt: new Date() })],
    });
    const result = await ctx.service.requestResend(superAdmin, {
      orderId: ORDER_ID,
      sessionId: SESSION_A,
    });
    expect(result.ok).toBe(true);
    expect(ctx.enqueued[0]).toMatchObject({
      jobName: 'invitations.dispatch',
      payload: { orderId: ORDER_ID, sessionIds: [SESSION_A], resend: true },
      options: { idempotencyKey: `invitations.resend:${ORDER_ID}:${SESSION_A}` },
    });
  });

  it('rejects a resend for a session that was never invited', async () => {
    const ctx = buildService({
      order: makeOrder({ status: 'sent', sentAt: new Date() }),
      sessions: [makeSession({ status: 'created' })],
    });
    const result = await ctx.service.requestResend(superAdmin, {
      orderId: ORDER_ID,
      sessionId: SESSION_A,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invitation/session_not_resendable' },
    });
  });

  it('rejects resend on silent-mode orders', async () => {
    const ctx = buildService({
      order: makeOrder({ status: 'sent', suppressNotifications: true }),
    });
    const result = await ctx.service.requestResend(superAdmin, { orderId: ORDER_ID });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invitation/notifications_suppressed' },
    });
  });
});

// ---------------------------------------------------------------------------
// bounce → email_error
// ---------------------------------------------------------------------------

describe('invitationService.recordInvitationBounce', () => {
  const bounce = {
    orderId: ORDER_ID,
    notificationId: NOTIFICATION_ID,
    sessionId: SESSION_A,
  };

  it('drives the order to email_error via the order service and alerts super admins', async () => {
    const ctx = buildService({
      order: makeOrder({ status: 'sent', sentAt: new Date() }),
      alertRecipients: ['admin@assessify.ie', 'ops@assessify.ie'],
    });
    const result = await ctx.service.recordInvitationBounce(bounce);
    expect(result).toMatchObject({ ok: true, value: { transitioned: true } });
    expect(ctx.transitions[0]).toMatchObject({
      caller: { kind: 'system' },
      orderId: ORDER_ID,
      input: {
        event: 'invitation_failed',
        errorDetail: {
          reason: 'invitation_hard_bounce',
          notificationId: NOTIFICATION_ID,
          sessionId: SESSION_A,
        },
      },
    });
    const alerts = ctx.sent.filter((message) => message.kind === 'error_alert');
    expect(alerts.map((message) => message.to)).toEqual([
      'admin@assessify.ie',
      'ops@assessify.ie',
    ]);
    expect(
      ctx.auditEvents.some((event) => event.action === 'invitation.bounced')
    ).toBe(true);
  });

  it('is idempotent: an already-errored order reports transitioned:false with no alert', async () => {
    const ctx = buildService({
      order: makeOrder({ status: 'email_error' }),
      alertRecipients: ['admin@assessify.ie'],
      orderServiceResult: () =>
        err({ code: 'order/illegal_transition', message: 'already email_error' }),
    });
    const result = await ctx.service.recordInvitationBounce(bounce);
    expect(result).toMatchObject({ ok: true, value: { transitioned: false } });
    expect(ctx.sent).toHaveLength(0);
    expect(ctx.auditEvents.some((event) => event.action === 'invitation.bounced')).toBe(false);
  });

  it('acknowledges bounces for unknown orders instead of failing the webhook batch', async () => {
    const ctx = buildService();
    const result = await ctx.service.recordInvitationBounce({
      ...bounce,
      orderId: '01890a5d-ac96-774b-bcce-b302099adead',
    });
    expect(result).toMatchObject({ ok: true, value: { transitioned: false } });
  });
});
