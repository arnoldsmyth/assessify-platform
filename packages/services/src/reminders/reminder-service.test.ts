import { describe, expect, it, vi } from 'vitest';
import {
  err,
  ok,
  systemCallerContext,
  type CallerContext,
  type Product,
} from '@assessify/domain';
import type {
  DueReminderQuery,
  ReminderSessionRecord,
  ReminderSessionRepository,
} from '@assessify/repositories';

import type { AuditService } from '../audit';
import type { NotificationService } from '../notifications';
import {
  createReminderService,
  isWithinSendWindow,
  manualReminderBlock,
  reminderBlock,
  REMINDER_MAX_COUNT,
  type ReminderServiceDeps,
} from './reminder-service';

/**
 * Reminder engine tests (D6 — spec 13). Repos/services are in-memory doubles
 * per package convention. Time is pinned: NOW is the sweep instant, sessions
 * are placed relative to it to probe every boundary of the due predicate.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const ORDER_ID = '01890a5d-ac96-774b-bcce-b302099a0001';
const PRODUCT_ID = '01890a5d-ac96-774b-bcce-b302099a0002';
const CLIENT_ID = '01890a5d-ac96-774b-bcce-b302099a0003';
const SESSION_A = '01890a5d-ac96-774b-bcce-b302099a000a';
const SESSION_B = '01890a5d-ac96-774b-bcce-b302099a000b';
const TOKEN_A = '9b2fbe45-9c17-4bd6-a0f5-2f4576a5c9a1';
const NOTIFICATION_ID = '01890a5d-ac96-774b-bcce-b302099a00ff';

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

function makeRecord(overrides: Partial<ReminderSessionRecord> = {}): ReminderSessionRecord {
  return {
    id: SESSION_A,
    orderId: ORDER_ID,
    token: TOKEN_A,
    status: 'invited',
    language: 'en',
    invitedAt: daysAgo(3),
    createdAt: daysAgo(3),
    reminderCount: 0,
    lastReminderAt: null,
    remindersSuppressed: false,
    order: {
      status: 'sent',
      type: 'bulk_named',
      clientId: CLIENT_ID,
      productId: PRODUCT_ID,
      reportLanguage: 'en',
      suppressNotifications: false,
    },
    respondent: { email: 'ada@example.com', firstName: 'Ada' },
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
    organizationId: '01900000-0000-7000-8000-00000000aaaa',
    defaultAccess: true,
    revenueSplitPct: null,
    royaltyPolicy: null,
    timezone: 'UTC',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
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

const noPermissions = {
  products: [] as string[],
  groups: [] as string[],
  canPlaceOrders: false,
  canViewResults: false,
  canReleaseReports: false,
};

const superAdmin: CallerContext = {
  kind: 'user',
  id: '01890a5d-ac96-774b-bcce-b302099a0100',
  roles: [{ role: 'super_admin', organizationId: null, productId: null, clientId: null, permissions: fullPermissions }],
};

const clientAdmin: CallerContext = {
  kind: 'user',
  id: '01890a5d-ac96-774b-bcce-b302099a0101',
  roles: [
    { role: 'client_admin', organizationId: null, productId: null, clientId: CLIENT_ID, permissions: fullPermissions },
  ],
};

const otherClientAdmin: CallerContext = {
  kind: 'user',
  id: '01890a5d-ac96-774b-bcce-b302099a0102',
  roles: [
    {
      role: 'client_admin',
      organizationId: null,
      productId: null,
      clientId: '01890a5d-ac96-774b-bcce-b302099a0999',
      permissions: fullPermissions,
    },
  ],
};

const orderingClientUser: CallerContext = {
  kind: 'user',
  id: '01890a5d-ac96-774b-bcce-b302099a0103',
  roles: [
    {
      role: 'client_user',
      organizationId: null,
      productId: null,
      clientId: CLIENT_ID,
      permissions: { ...noPermissions, canPlaceOrders: true },
    },
  ],
};

const readOnlyClientUser: CallerContext = {
  kind: 'user',
  id: '01890a5d-ac96-774b-bcce-b302099a0104',
  roles: [
    { role: 'client_user', organizationId: null, productId: null, clientId: CLIENT_ID, permissions: noPermissions },
  ],
};

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface Harness {
  service: ReturnType<typeof createReminderService>;
  sessions: ReminderSessionRepository;
  listDue: ReturnType<typeof vi.fn>;
  markReminderSent: ReturnType<typeof vi.fn>;
  setSuppressed: ReturnType<typeof vi.fn>;
  notificationSend: ReturnType<typeof vi.fn>;
  auditRecords: { actor: unknown; action: string; entityRef: unknown; detail: unknown }[];
}

function makeHarness(options: {
  records?: ReminderSessionRecord[];
  /** Batches returned by successive listDue calls (overrides `records`). */
  batches?: ReminderSessionRecord[][];
  product?: Product | null;
  config?: Partial<ReminderServiceDeps['config']> & {
    sweepBatchSize?: number;
    sendWindow?: { fromHour: number; toHour: number };
  };
  markResult?: boolean;
  setResult?: boolean;
  sendFails?: boolean;
  now?: Date;
}): Harness {
  const records = options.records ?? [];
  const batchQueue = options.batches ? [...options.batches] : null;
  const listDue = vi.fn(async (_query: DueReminderQuery) => {
    if (batchQueue) return batchQueue.shift() ?? [];
    return records;
  });
  const findById = vi.fn(async (sessionId: string) => {
    return records.find((record) => record.id === sessionId) ?? null;
  });
  const markReminderSent = vi.fn(async () => options.markResult ?? true);
  const setSuppressed = vi.fn(async () => options.setResult ?? true);
  const sessions: ReminderSessionRepository = {
    listDue,
    findById,
    markReminderSent,
    setSuppressed,
  };

  const notificationSend = vi.fn(async () =>
    options.sendFails
      ? err({ code: 'notification/enqueue_failed', message: 'queue down' })
      : ok({ notificationId: NOTIFICATION_ID, status: 'queued' as const })
  );
  const notifications = { send: notificationSend } as unknown as Pick<
    NotificationService,
    'send'
  >;

  const auditRecords: Harness['auditRecords'] = [];
  const audit: AuditService = {
    record: vi.fn(async (actor, action, entityRef, detail) => {
      auditRecords.push({ actor, action, entityRef, detail });
      return ok({
        id: NOTIFICATION_ID,
        actor: { kind: actor.kind, id: actor.id ?? null },
        action,
        entityRef,
        detail: detail ?? null,
        createdAt: NOW,
      });
    }),
    listByEntity: vi.fn(async () => ok({ items: [], hasMore: false })),
  };

  const product = options.product === undefined ? makeProduct() : options.product;
  const service = createReminderService({
    sessions,
    products: { findById: vi.fn(async () => product) },
    customDomains: { findActiveByProductId: vi.fn(async () => []) },
    notifications,
    audit,
    config: {
      slugBaseDomain: 'assessify.ie',
      platformSender: { name: 'Assessify', address: 'no-reply@assessify.ie' },
      ...options.config,
    },
    now: () => options.now ?? NOW,
  });
  return { service, sessions, listDue, markReminderSent, setSuppressed, notificationSend, auditRecords };
}

// ---------------------------------------------------------------------------
// Due predicate — every boundary of spec 13
// ---------------------------------------------------------------------------

describe('reminderBlock (due selection)', () => {
  it('is due when the invitation is ≥2 days old, inside the 30-day window', () => {
    expect(reminderBlock(makeRecord(), NOW)).toBeNull();
  });

  it('honours the 2-day gate boundary exactly (invitation anchor)', () => {
    expect(reminderBlock(makeRecord({ invitedAt: daysAgo(2) }), NOW)).toBeNull();
    expect(
      reminderBlock(makeRecord({ invitedAt: new Date(NOW.getTime() - 2 * DAY + 1) }), NOW)
    ).toBe('not_due');
  });

  it('spaces from the LAST reminder once one was sent', () => {
    const base = { invitedAt: daysAgo(10), reminderCount: 3 };
    expect(reminderBlock(makeRecord({ ...base, lastReminderAt: daysAgo(2) }), NOW)).toBeNull();
    expect(reminderBlock(makeRecord({ ...base, lastReminderAt: daysAgo(1) }), NOW)).toBe(
      'not_due'
    );
  });

  it('stops permanently past 30 days from the invitation (boundary inclusive)', () => {
    expect(
      reminderBlock(makeRecord({ invitedAt: daysAgo(30), lastReminderAt: daysAgo(2) }), NOW)
    ).toBeNull();
    expect(
      reminderBlock(
        makeRecord({
          invitedAt: new Date(NOW.getTime() - 30 * DAY - 1),
          lastReminderAt: daysAgo(2),
        }),
        NOW
      )
    ).toBe('window_expired');
  });

  it('stops at the reminder cap', () => {
    expect(
      reminderBlock(
        makeRecord({ reminderCount: REMINDER_MAX_COUNT, lastReminderAt: daysAgo(2) }),
        NOW
      )
    ).toBe('count_cap');
  });

  it('skips suppressed sessions', () => {
    expect(reminderBlock(makeRecord({ remindersSuppressed: true }), NOW)).toBe('suppressed');
  });

  it('skips completed (and other post-fulfilment) sessions', () => {
    expect(reminderBlock(makeRecord({ status: 'completed' }), NOW)).toBe('session_status');
    expect(reminderBlock(makeRecord({ status: 'scored' }), NOW)).toBe('session_status');
    expect(reminderBlock(makeRecord({ status: 'created' }), NOW)).toBe('session_status');
  });

  it('runs only while the order is `sent` (cancel/hold/complete stop reminders)', () => {
    for (const status of ['approved', 'cancelled', 'on_hold', 'completed', 'refunded'] as const) {
      expect(
        reminderBlock(makeRecord({ order: { ...makeRecord().order, status } }), NOW)
      ).toBe('order_status');
    }
  });

  it('never auto-reminds batch-code orders or silent (suppressed-notification) orders', () => {
    expect(
      reminderBlock(makeRecord({ order: { ...makeRecord().order, type: 'batch_code' } }), NOW)
    ).toBe('order_type');
    expect(
      reminderBlock(
        makeRecord({ order: { ...makeRecord().order, suppressNotifications: true } }),
        NOW
      )
    ).toBe('notifications_suppressed');
  });

  it('requires an email on file', () => {
    expect(reminderBlock(makeRecord({ respondent: null }), NOW)).toBe('missing_email');
    expect(
      reminderBlock(makeRecord({ respondent: { email: null, firstName: null } }), NOW)
    ).toBe('missing_email');
  });

  it('anchors self-registered (group) sessions on created_at when never invited', () => {
    const selfRegistered = makeRecord({
      status: 'started',
      invitedAt: null,
      createdAt: daysAgo(3),
      order: { ...makeRecord().order, type: 'group' },
    });
    expect(reminderBlock(selfRegistered, NOW)).toBeNull();
    expect(
      reminderBlock({ ...selfRegistered, createdAt: daysAgo(1) }, NOW)
    ).toBe('not_due');
  });
});

describe('manualReminderBlock', () => {
  it('bypasses spacing, the 30-day stop, the cap, and the batch-code rule', () => {
    expect(manualReminderBlock(makeRecord({ lastReminderAt: daysAgo(0.5) }), NOW)).toBeNull();
    expect(manualReminderBlock(makeRecord({ invitedAt: daysAgo(45) }), NOW)).toBeNull();
    expect(
      manualReminderBlock(makeRecord({ reminderCount: REMINDER_MAX_COUNT }), NOW)
    ).toBeNull();
    expect(
      manualReminderBlock(
        makeRecord({ order: { ...makeRecord().order, type: 'batch_code' } }),
        NOW
      )
    ).toBeNull();
  });

  it('still blocks suppression, completion, order state, and missing email', () => {
    expect(manualReminderBlock(makeRecord({ remindersSuppressed: true }), NOW)).toBe(
      'suppressed'
    );
    expect(manualReminderBlock(makeRecord({ status: 'completed' }), NOW)).toBe('session_status');
    expect(
      manualReminderBlock(makeRecord({ order: { ...makeRecord().order, status: 'on_hold' } }), NOW)
    ).toBe('order_status');
    expect(manualReminderBlock(makeRecord({ respondent: null }), NOW)).toBe('missing_email');
  });
});

describe('isWithinSendWindow', () => {
  it('is open [08:00, 18:00) in the given timezone', () => {
    expect(isWithinSendWindow(new Date('2026-07-21T08:00:00Z'), 'UTC')).toBe(true);
    expect(isWithinSendWindow(new Date('2026-07-21T07:59:00Z'), 'UTC')).toBe(false);
    expect(isWithinSendWindow(new Date('2026-07-21T17:59:00Z'), 'UTC')).toBe(true);
    expect(isWithinSendWindow(new Date('2026-07-21T18:00:00Z'), 'UTC')).toBe(false);
  });

  it('respects the timezone offset (Dublin is UTC+1 in July)', () => {
    expect(isWithinSendWindow(new Date('2026-07-21T07:30:00Z'), 'Europe/Dublin')).toBe(true);
    expect(isWithinSendWindow(new Date('2026-07-21T17:30:00Z'), 'Europe/Dublin')).toBe(false);
  });

  it('falls back to UTC on an invalid timezone instead of blocking forever', () => {
    expect(isWithinSendWindow(new Date('2026-07-21T12:00:00Z'), 'Not/AZone')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sweep()
// ---------------------------------------------------------------------------

describe('sweep', () => {
  it('stamps (guarded) then sends one reminder per due session — link, no PIN', async () => {
    const h = makeHarness({ records: [makeRecord(), makeRecord({ id: SESSION_B })] });
    const result = await h.service.sweep();
    expect(result.ok && result.value).toEqual({
      sent: 2,
      skipped: 0,
      deferred: 0,
      failed: [],
    });
    expect(h.markReminderSent).toHaveBeenCalledWith(SESSION_A, 0, NOW);
    expect(h.notificationSend).toHaveBeenCalledTimes(2);
    const message = h.notificationSend.mock.calls[0]?.[0] as {
      kind: string;
      data: Record<string, unknown>;
      refs: Record<string, unknown>;
    };
    expect(message.kind).toBe('reminder');
    expect(message.data.entryUrl).toBe(`https://pro-d.assessify.ie/a/${TOKEN_A}`);
    expect(message.data.reminderNumber).toBe(1);
    expect(message.data).not.toHaveProperty('pin');
    expect(message.refs).toEqual({ orderId: ORDER_ID, sessionId: SESSION_A });
    // Stamp strictly before send (idempotency under crash/retry).
    const stampOrder = h.markReminderSent.mock.invocationCallOrder[0] ?? Infinity;
    const sendOrder = h.notificationSend.mock.invocationCallOrder[0] ?? 0;
    expect(stampOrder).toBeLessThan(sendOrder);
    // Audit summary carries counts + ids only.
    expect(h.auditRecords).toHaveLength(1);
    expect(h.auditRecords[0]?.action).toBe('reminder.sweep_completed');
  });

  it('skips (never sends) when the guarded update loses to a concurrent run', async () => {
    const h = makeHarness({ records: [makeRecord()], markResult: false });
    const result = await h.service.sweep();
    expect(result.ok && result.value).toMatchObject({ sent: 0, skipped: 1 });
    expect(h.notificationSend).not.toHaveBeenCalled();
  });

  it('re-checks candidates and drops ones the query should not have returned', async () => {
    const h = makeHarness({ records: [makeRecord({ remindersSuppressed: true })] });
    const result = await h.service.sweep();
    expect(result.ok && result.value).toMatchObject({ sent: 0, skipped: 1 });
    expect(h.markReminderSent).not.toHaveBeenCalled();
  });

  it('defers sessions outside the product-timezone send window, untouched', async () => {
    // 02:00 UTC is outside [08:00, 18:00) for a UTC-timezone product.
    const h = makeHarness({
      records: [makeRecord({ invitedAt: daysAgo(3), createdAt: daysAgo(3) })],
      now: new Date('2026-07-21T02:00:00.000Z'),
    });
    const result = await h.service.sweep();
    expect(result.ok && result.value).toMatchObject({ sent: 0, deferred: 1 });
    expect(h.markReminderSent).not.toHaveBeenCalled();
    expect(h.auditRecords).toHaveLength(0); // idle sweep → no audit noise
  });

  it('records failed sends (session already stamped) and keeps going', async () => {
    const h = makeHarness({
      records: [makeRecord(), makeRecord({ id: SESSION_B })],
      sendFails: true,
    });
    const result = await h.service.sweep();
    expect(result.ok && result.value).toMatchObject({
      sent: 0,
      failed: [
        { sessionId: SESSION_A, code: 'notification/enqueue_failed' },
        { sessionId: SESSION_B, code: 'notification/enqueue_failed' },
      ],
    });
    expect(h.markReminderSent).toHaveBeenCalledTimes(2);
  });

  it('paginates full batches and terminates when a batch brings nothing new', async () => {
    const a = makeRecord();
    const b = makeRecord({ id: SESSION_B, token: '9b2fbe45-9c17-4bd6-a0f5-2f4576a5c9b2' });
    // Batch size 1: first two batches advance; the third repeats an already-
    // seen (deferred/skipped-style) record and must end the loop.
    const h = makeHarness({
      batches: [[a], [b], [a]],
      config: { sweepBatchSize: 1 },
    });
    const result = await h.service.sweep();
    expect(result.ok && result.value).toMatchObject({ sent: 2 });
    expect(h.listDue).toHaveBeenCalledTimes(3);
  });

  it('surfaces repository failures as a Result, not a throw', async () => {
    const h = makeHarness({ records: [] });
    h.listDue.mockRejectedValueOnce(new Error('db down'));
    const result = await h.service.sweep();
    expect(!result.ok && result.error.code).toBe('reminder/storage_failed');
  });
});

// ---------------------------------------------------------------------------
// sendManual()
// ---------------------------------------------------------------------------

describe('sendManual', () => {
  const freshReminder = makeRecord({ lastReminderAt: daysAgo(0.25), reminderCount: 4 });

  it('bypasses the 2-day gate, stamps with CAS, sends, and audits the caller', async () => {
    const h = makeHarness({ records: [freshReminder] });
    const result = await h.service.sendManual(superAdmin, { sessionId: SESSION_A });
    expect(result.ok && result.value).toEqual({
      sessionId: SESSION_A,
      notificationId: NOTIFICATION_ID,
      reminderCount: 5,
    });
    expect(h.markReminderSent).toHaveBeenCalledWith(SESSION_A, 4, NOW);
    expect(h.auditRecords[0]).toMatchObject({
      action: 'reminder.manual_sent',
      actor: { kind: 'user', id: superAdmin.id },
      detail: { orderId: ORDER_ID, reminderCount: 5 },
    });
  });

  it('allows client_admin and ordering client_user in the order client scope', async () => {
    for (const caller of [clientAdmin, orderingClientUser, systemCallerContext()]) {
      const h = makeHarness({ records: [makeRecord()] });
      const result = await h.service.sendManual(caller, { sessionId: SESSION_A });
      expect(result.ok).toBe(true);
    }
  });

  it('hides the session from out-of-scope and under-permissioned callers', async () => {
    for (const caller of [otherClientAdmin, readOnlyClientUser]) {
      const h = makeHarness({ records: [makeRecord()] });
      const result = await h.service.sendManual(caller, { sessionId: SESSION_A });
      expect(!result.ok && result.error.code).toBe('reminder/session_not_found');
      expect(h.notificationSend).not.toHaveBeenCalled();
    }
  });

  it('never bypasses suppression or completion', async () => {
    const suppressed = makeHarness({ records: [makeRecord({ remindersSuppressed: true })] });
    const r1 = await suppressed.service.sendManual(superAdmin, { sessionId: SESSION_A });
    expect(!r1.ok && r1.error.code).toBe('reminder/suppressed');

    const completed = makeHarness({ records: [makeRecord({ status: 'completed' })] });
    const r2 = await completed.service.sendManual(superAdmin, { sessionId: SESSION_A });
    expect(!r2.ok && r2.error.code).toBe('reminder/session_status');
  });

  it('rejects orders outside the `sent` state', async () => {
    const h = makeHarness({
      records: [makeRecord({ order: { ...makeRecord().order, status: 'on_hold' } })],
    });
    const result = await h.service.sendManual(superAdmin, { sessionId: SESSION_A });
    expect(!result.ok && result.error.code).toBe('reminder/order_status');
  });

  it('reports a conflict (nothing sent) when the CAS loses', async () => {
    const h = makeHarness({ records: [makeRecord()], markResult: false });
    const result = await h.service.sendManual(superAdmin, { sessionId: SESSION_A });
    expect(!result.ok && result.error.code).toBe('reminder/conflict');
    expect(h.notificationSend).not.toHaveBeenCalled();
  });

  it('validates input at the boundary', async () => {
    const h = makeHarness({ records: [] });
    const result = await h.service.sendManual(superAdmin, { sessionId: 'not-a-uuid' });
    expect(!result.ok && result.error.code).toBe('reminder/validation');
  });
});

// ---------------------------------------------------------------------------
// setSuppressed()
// ---------------------------------------------------------------------------

describe('setSuppressed', () => {
  it('sets the flag and audits the change (per-caller actor)', async () => {
    const h = makeHarness({ records: [makeRecord()] });
    const result = await h.service.setSuppressed(clientAdmin, {
      sessionId: SESSION_A,
      suppressed: true,
    });
    expect(result.ok && result.value).toEqual({ sessionId: SESSION_A, suppressed: true });
    expect(h.setSuppressed).toHaveBeenCalledWith(SESSION_A, true, NOW);
    expect(h.auditRecords[0]).toMatchObject({
      action: 'reminder.suppression_changed',
      actor: { kind: 'user', id: clientAdmin.id },
      detail: { suppressed: true },
    });
  });

  it('resumes reminders with suppressed=false', async () => {
    const h = makeHarness({ records: [makeRecord({ remindersSuppressed: true })] });
    const result = await h.service.setSuppressed(superAdmin, {
      sessionId: SESSION_A,
      suppressed: false,
    });
    expect(result.ok && result.value).toEqual({ sessionId: SESSION_A, suppressed: false });
  });

  it('hides the session from out-of-scope callers', async () => {
    const h = makeHarness({ records: [makeRecord()] });
    const result = await h.service.setSuppressed(otherClientAdmin, {
      sessionId: SESSION_A,
      suppressed: true,
    });
    expect(!result.ok && result.error.code).toBe('reminder/session_not_found');
    expect(h.setSuppressed).not.toHaveBeenCalled();
  });

  it('reports an unknown session as not found', async () => {
    const h = makeHarness({ records: [] });
    const result = await h.service.setSuppressed(superAdmin, {
      sessionId: SESSION_B,
      suppressed: true,
    });
    expect(!result.ok && result.error.code).toBe('reminder/session_not_found');
  });
});
