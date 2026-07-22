import { describe, expect, it } from 'vitest';
import {
  err,
  ok,
  type NotificationLogEntry,
  type NotificationStatus,
  type Order,
  type Product,
} from '@assessify/domain';
import type {
  ActiveCustomDomain,
  ClientNotificationProfile,
  InvitationSessionRecord,
} from '@assessify/repositories';

import type { AuditService } from '../audit';
import type { NotificationService } from '../notifications';
import {
  createCompletionNotificationService,
  type CompletionNotificationServiceDeps,
} from './completion-notification-service';

/**
 * Completion notification hook tests (E6 — spec 13). Repos/services are
 * in-memory doubles per package convention. Covered: policy gates for both
 * legs, recipient/kind/refs/sender/language correctness, the report-link
 * rule (respondent only), dedupe across re-releases, and failure
 * containment (send errors never throw; broken refs do).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORDER_ID = '01890a5d-ac96-774b-bcce-b302099a0001';
const PRODUCT_ID = '01890a5d-ac96-774b-bcce-b302099a0002';
const CLIENT_ID = '01890a5d-ac96-774b-bcce-b302099a0003';
const QV_ID = '01890a5d-ac96-774b-bcce-b302099a0004';
const SESSION_ID = '01890a5d-ac96-774b-bcce-b302099a000a';
const REPORT_ID = '01890a5d-ac96-774b-bcce-b302099a00e3';
const TOKEN = '9b2fbe45-9c17-4bd6-a0f5-2f4576a5c9a1';

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    reference: 'ORD-00042',
    type: 'named',
    status: 'processing_report',
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
    sentAt: new Date('2026-07-02T10:00:00Z'),
    completedAt: null,
    createdAt: new Date('2026-07-01T09:00:00Z'),
    updatedAt: new Date('2026-07-01T10:00:00Z'),
    ...overrides,
  };
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    organizationId: '01890000-0000-7000-8000-0000000000a1',
    slug: 'pro-d',
    name: 'Pro-D',
    status: 'active',
    defaultAccess: true,
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
    revenueSplitPct: null,
    royaltyPolicy: null,
    timezone: 'Europe/Dublin',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeClientProfile(
  overrides: Partial<ClientNotificationProfile> = {}
): ClientNotificationProfile {
  return {
    id: CLIENT_ID,
    name: 'Acme HR',
    billingEmail: 'billing@acme.example',
    notificationOverrides: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<InvitationSessionRecord> = {}): InvitationSessionRecord {
  return {
    id: SESSION_ID,
    orderId: ORDER_ID,
    token: TOKEN,
    status: 'report_ready',
    language: 'de',
    invitedAt: new Date('2026-07-02T10:00:00Z'),
    respondent: { email: 'ada@example.com', firstName: 'Ada' },
    ...overrides,
  };
}

function makeLogEntry(
  kind: NotificationLogEntry['kind'],
  status: NotificationStatus
): NotificationLogEntry {
  return {
    id: '01890a5d-ac96-774b-bcce-b302099a0aaa',
    orderId: ORDER_ID,
    sessionId: SESSION_ID,
    kind,
    recipient: 'redacted@example.com',
    template: 'x',
    language: 'en',
    providerMessageId: null,
    status,
    createdAt: new Date('2026-07-03T10:00:00Z'),
    updatedAt: new Date('2026-07-03T10:00:00Z'),
  };
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface SentNotification {
  kind: string;
  to: string;
  subject: string;
  template: string;
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
      return ok({
        notificationId: '01890a5d-ac96-774b-bcce-b302099a00ff',
        status: 'queued' as const,
      });
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

interface Fixture {
  order?: Order | null;
  product?: Product | null;
  client?: ClientNotificationProfile | null;
  sessions?: InvitationSessionRecord[];
  customDomains?: ActiveCustomDomain[];
  logEntries?: NotificationLogEntry[];
  failSendFor?: (to: string) => boolean;
}

function setup(fixture: Fixture = {}) {
  const order = fixture.order === undefined ? makeOrder() : fixture.order;
  const product = fixture.product === undefined ? makeProduct() : fixture.product;
  const client = fixture.client === undefined ? makeClientProfile() : fixture.client;
  const sessionRows = fixture.sessions ?? [makeSession()];
  const logEntries = fixture.logEntries ?? [];
  const { notifications, sent } = createFakeNotifications(fixture.failSendFor);
  const { audit, events } = createFakeAudit();

  const deps: CompletionNotificationServiceDeps = {
    orders: {
      async findById(id) {
        return order && order.id === id ? order : null;
      },
    },
    products: {
      async findById(id) {
        return product && product.id === id ? product : null;
      },
    },
    clients: {
      async findNotificationProfile(id) {
        return client && client.id === id ? client : null;
      },
    },
    sessions: {
      async listByOrder(orderId) {
        return sessionRows.filter((row) => row.orderId === orderId);
      },
    },
    customDomains: {
      async findActiveByProductId() {
        return fixture.customDomains ?? [];
      },
    },
    notificationLog: {
      async listByKindAndSession(kind, sessionId) {
        return logEntries.filter(
          (entry) => entry.kind === kind && entry.sessionId === sessionId
        );
      },
    },
    notifications,
    audit,
    config: {
      slugBaseDomain: 'assessify.ie',
      platformSender: { name: 'Assessify', address: 'no-reply@assessify.ie' },
    },
  };
  const service = createCompletionNotificationService(deps);
  return { service, sent, events };
}

const RELEASE = {
  reportId: REPORT_ID,
  orderId: ORDER_ID,
  sessionId: SESSION_ID,
  mode: 'auto' as const,
};

/** Order override helper: policy under the `completion` jsonb key. */
function orderPolicy(policy: unknown): Partial<Order> {
  return { notificationPolicy: { completion: policy } };
}

// ---------------------------------------------------------------------------
// Respondent leg (report_ready)
// ---------------------------------------------------------------------------

describe('completion notifications — respondent report_ready', () => {
  it('default policy mails the respondent their report link in the session language', async () => {
    const { service, sent } = setup();
    const result = await service.notifyReportReleased(RELEASE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.policySource).toBe('default');
    expect(result.value.respondent).toBe('queued');
    expect(result.value.client).toEqual({ queued: 0, failed: 0, skipped: 'policy' });

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.kind).toBe('report_ready');
    expect(mail.to).toBe('ada@example.com');
    expect(mail.template).toBe('report-ready');
    expect(mail.language).toBe('de'); // session language, not order.reportLanguage
    expect(mail.refs).toEqual({ orderId: ORDER_ID, sessionId: SESSION_ID });
    expect(mail.data['reportUrl']).toBe(`https://pro-d.assessify.ie/a/${TOKEN}/report`);
    expect(mail.sender.from.address).toBe('no-reply@assessify.ie');
  });

  it('uses the product sender identity and a client-scoped custom domain host', async () => {
    const { service, sent } = setup({
      product: makeProduct({
        branding: { emailFrom: { name: 'Pro-D Reports', address: 'reports@pro-d.example' } },
      }),
      customDomains: [
        { hostname: 'assess.generic.example', productId: PRODUCT_ID, clientId: null },
        { hostname: 'assess.acme.example', productId: PRODUCT_ID, clientId: CLIENT_ID },
      ],
    });
    await service.notifyReportReleased(RELEASE);

    expect(sent[0]?.sender.from.address).toBe('reports@pro-d.example');
    expect(sent[0]?.data['reportUrl']).toBe(`https://assess.acme.example/a/${TOKEN}/report`);
  });

  it('falls back to the order report language when the session has none', async () => {
    const { service, sent } = setup({
      order: makeOrder({ reportLanguage: 'fr' }),
      sessions: [makeSession({ language: null })],
    });
    await service.notifyReportReleased(RELEASE);
    expect(sent[0]?.language).toBe('fr');
  });

  it('omits the report link when the respondent recipient does not opt in', async () => {
    const { service, sent } = setup({
      order: makeOrder(
        orderPolicy({ recipients: [{ type: 'respondent', includeReportLink: false }] })
      ),
    });
    const result = await service.notifyReportReleased(RELEASE);
    expect(result.ok && result.value.respondent).toBe('queued');
    expect(sent[0]?.data).not.toHaveProperty('reportUrl');
  });

  it('skips the respondent when the policy names no respondent recipient', async () => {
    const { service, sent } = setup({
      order: makeOrder(orderPolicy({ recipients: [{ type: 'client' }] })),
    });
    const result = await service.notifyReportReleased(RELEASE);
    expect(result.ok && result.value.respondent).toBe('skipped_policy');
    expect(sent.every((mail) => mail.kind !== 'report_ready')).toBe(true);
  });

  it('skips (never throws) when the respondent has no email address', async () => {
    const { service, sent } = setup({ sessions: [makeSession({ respondent: null })] });
    const result = await service.notifyReportReleased(RELEASE);
    expect(result.ok && result.value.respondent).toBe('skipped_missing_email');
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Client leg (completion_notice)
// ---------------------------------------------------------------------------

describe('completion notifications — client completion_notice', () => {
  const clientAndThirdParty = orderPolicy({
    recipients: [
      { type: 'client' },
      { type: 'third_party', emails: ['hr@acme.example', 'manager@acme.example'] },
    ],
  });

  it('mails the billing contact and named third parties, platform sender, no PII/link', async () => {
    const { service, sent } = setup({ order: makeOrder(clientAndThirdParty) });
    const result = await service.notifyReportReleased(RELEASE);

    expect(result.ok && result.value.client).toEqual({ queued: 3, failed: 0, skipped: null });
    const notices = sent.filter((mail) => mail.kind === 'completion_notice');
    expect(notices.map((mail) => mail.to).sort()).toEqual([
      'billing@acme.example',
      'hr@acme.example',
      'manager@acme.example',
    ]);
    for (const notice of notices) {
      expect(notice.template).toBe('completion-notice');
      expect(notice.language).toBe('en');
      expect(notice.sender.from.address).toBe('no-reply@assessify.ie');
      expect(notice.refs).toEqual({ orderId: ORDER_ID, sessionId: SESSION_ID });
      // No respondent identity and never the respondent's token link.
      expect(notice.data).toEqual({
        productName: 'Pro-D',
        orderReference: 'ORD-00042',
        clientName: 'Acme HR',
      });
      expect(JSON.stringify(notice.data)).not.toContain(TOKEN);
    }
  });

  it('explicit client emails replace the billing fallback', async () => {
    const { service, sent } = setup({
      order: makeOrder(
        orderPolicy({ recipients: [{ type: 'client', emails: ['people-ops@acme.example'] }] })
      ),
    });
    await service.notifyReportReleased(RELEASE);
    expect(sent.map((mail) => mail.to)).toEqual(['people-ops@acme.example']);
  });

  it('reports missing_recipients when the client has no billing email', async () => {
    const { service, sent } = setup({
      order: makeOrder(orderPolicy({ recipients: [{ type: 'client' }] })),
      client: makeClientProfile({ billingEmail: null }),
    });
    const result = await service.notifyReportReleased(RELEASE);
    expect(result.ok && result.value.client).toEqual({
      queued: 0,
      failed: 0,
      skipped: 'missing_recipients',
    });
    expect(sent).toHaveLength(0);
  });

  it('resolves the client-layer override when the order has none', async () => {
    const { service, sent } = setup({
      client: makeClientProfile({
        notificationOverrides: { completion: { recipients: [{ type: 'client' }] } },
      }),
    });
    const result = await service.notifyReportReleased(RELEASE);
    expect(result.ok && result.value.policySource).toBe('client');
    expect(sent.map((mail) => mail.kind)).toEqual(['completion_notice']);
  });

  it('resolves the product default below the client layer', async () => {
    const { service } = setup({
      product: makeProduct({
        notificationDefaults: { completion: { recipients: [] } },
      }),
    });
    const result = await service.notifyReportReleased(RELEASE);
    expect(result.ok && result.value.policySource).toBe('product');
    expect(result.ok && result.value.respondent).toBe('skipped_policy');
  });
});

// ---------------------------------------------------------------------------
// Dedupe, suppression, failure containment
// ---------------------------------------------------------------------------

describe('completion notifications — idempotency and containment', () => {
  const bothLegs = orderPolicy({
    recipients: [{ type: 'respondent', includeReportLink: true }, { type: 'client' }],
  });

  it('a re-release sends nothing when both kinds already left', async () => {
    const { service, sent } = setup({
      order: makeOrder(bothLegs),
      logEntries: [makeLogEntry('report_ready', 'sent'), makeLogEntry('completion_notice', 'queued')],
    });
    const result = await service.notifyReportReleased({ ...RELEASE, mode: 'manual' });
    expect(result.ok && result.value.respondent).toBe('skipped_duplicate');
    expect(result.ok && result.value.client).toEqual({ queued: 0, failed: 0, skipped: 'duplicate' });
    expect(sent).toHaveLength(0);
  });

  it('kinds dedupe independently (only the missing kind is sent)', async () => {
    const { service, sent } = setup({
      order: makeOrder(bothLegs),
      logEntries: [makeLogEntry('report_ready', 'delivered')],
    });
    const result = await service.notifyReportReleased(RELEASE);
    expect(result.ok && result.value.respondent).toBe('skipped_duplicate');
    expect(sent.map((mail) => mail.kind)).toEqual(['completion_notice']);
  });

  it('terminally failed prior sends do not block a re-release', async () => {
    const { service, sent } = setup({
      order: makeOrder(bothLegs),
      logEntries: [
        makeLogEntry('report_ready', 'failed'),
        makeLogEntry('completion_notice', 'bounced'),
      ],
    });
    const result = await service.notifyReportReleased(RELEASE);
    expect(result.ok && result.value.respondent).toBe('queued');
    expect(sent.map((mail) => mail.kind).sort()).toEqual(['completion_notice', 'report_ready']);
  });

  it('suppress_notifications silences everything (silent mode, spec 06)', async () => {
    const { service, sent, events } = setup({
      order: makeOrder({ ...bothLegs, suppressNotifications: true }),
    });
    const result = await service.notifyReportReleased(RELEASE);
    expect(result.ok && result.value.skipped).toBe('notifications_suppressed');
    expect(sent).toHaveLength(0);
    expect(events.map((event) => event.action)).toEqual(['notification.completion_dispatched']);
  });

  it('aggregate releases (no session) are a no-op, not an error', async () => {
    const { service, sent } = setup();
    const result = await service.notifyReportReleased({ ...RELEASE, sessionId: null });
    expect(result.ok && result.value.skipped).toBe('aggregate_report');
    expect(sent).toHaveLength(0);
  });

  it('notification-service failures land in the summary — the hook never throws for them', async () => {
    const { service, events } = setup({
      order: makeOrder(bothLegs),
      failSendFor: () => true,
    });
    await expect(service.onReportReleased(RELEASE)).resolves.toBeUndefined();
    const result = await service.notifyReportReleased(RELEASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.respondent).toBe('failed');
    expect(result.value.client).toEqual({ queued: 0, failed: 1, skipped: null });
    // Audit carries counts/codes only — never addresses.
    const details = JSON.stringify(events.map((event) => event.detail));
    expect(details).not.toContain('@');
    expect(events.at(-1)?.action).toBe('notification.completion_dispatched');
  });

  it('audits every processed release with ids/codes only', async () => {
    const { service, events } = setup();
    await service.notifyReportReleased(RELEASE);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.action).toBe('notification.completion_dispatched');
    expect(event.entity).toEqual({ type: 'report', id: REPORT_ID });
    expect(event.detail).toMatchObject({
      orderId: ORDER_ID,
      sessionId: SESSION_ID,
      policySource: 'default',
      respondent: 'queued',
    });
    expect(JSON.stringify(event.detail)).not.toContain('ada@example.com');
  });

  it('the hook throws on broken references so the release seam audits it', async () => {
    const { service } = setup({ order: null });
    await expect(service.onReportReleased(RELEASE)).rejects.toThrow(
      /completion_notification\/order_not_found/
    );
  });

  it('errors when the released session is missing from the order', async () => {
    const { service } = setup({ sessions: [] });
    const result = await service.notifyReportReleased(RELEASE);
    expect(!result.ok && result.error.code).toBe('completion_notification/session_not_found');
  });
});
