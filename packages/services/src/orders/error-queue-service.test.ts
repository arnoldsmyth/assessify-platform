import {
  ok,
  systemCallerContext,
  type AuditEvent,
  type CallerContext,
  type NotificationLogEntry,
  type Order,
  type Product,
  type RoleAssignment,
} from '@assessify/domain';
import type {
  ClientRepository,
  ClientSummary,
  NotificationLogRepository,
  OrderRepository,
  ProductRepository,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import {
  createErrorQueueService,
  retryEventForErrorStatus,
  type ErrorQueueServiceDeps,
} from './error-queue-service';

const CLIENT_ID = '33333333-3333-7333-8333-333333333333';
const PRODUCT_ID = '55555555-5555-7555-8555-555555555555';
const QV_ID = '66666666-6666-7666-8666-666666666666';
const ORDER_A = '01890000-0000-7000-8000-00000000000a';
const ORDER_B = '01890000-0000-7000-8000-00000000000b';

function assignment(
  role: RoleAssignment['role'],
  overrides: Partial<RoleAssignment> = {}
): RoleAssignment {
  return {
    role,
    organizationId: null,
    productId: null,
    clientId: null,
    permissions: {
      products: [],
      groups: [],
      canPlaceOrders: false,
      canViewResults: false,
      canReleaseReports: false,
    },
    ...overrides,
  };
}

const superAdmin: CallerContext = {
  kind: 'user',
  id: '11111111-1111-7111-8111-111111111111',
  roles: [assignment('super_admin')],
};
const clientAdmin: CallerContext = {
  kind: 'user',
  id: '22222222-2222-7222-8222-222222222222',
  roles: [assignment('client_admin', { clientId: CLIENT_ID })],
};
const assessmentAdmin: CallerContext = {
  kind: 'user',
  id: '88888888-8888-7888-8888-888888888888',
  roles: [assignment('assessment_admin', { organizationId: '01890000-0000-7000-8000-0000000000a1' })],
};
const apiKeyCaller: CallerContext = {
  kind: 'api_key',
  id: 'ak_test',
  roles: [],
};
const system = systemCallerContext();

function fixtureOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_A,
    reference: 'ORD-00042',
    type: 'named',
    status: 'payment_error',
    clientId: CLIENT_ID,
    productId: PRODUCT_ID,
    questionnaireVersionId: QV_ID,
    reportTemplateVersionId: null,
    reportLanguage: 'en',
    reportModel: 'individual',
    currency: 'EUR',
    subtotal: 15000,
    discountTotal: 0,
    total: 15000,
    paymentProvider: null,
    entitlementId: null,
    notificationPolicy: null,
    suppressNotifications: false,
    expectedRespondents: null,
    pageSize: null,
    isTest: false,
    relatedOrderId: null,
    placedByUserId: null,
    placedVia: 'admin',
    errorDetail: { code: 'card_declined' },
    source: 'native',
    legacyId: null,
    approvedAt: null,
    sentAt: null,
    completedAt: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-10T09:00:00Z'),
    ...overrides,
  };
}

function statusChanged(
  orderId: string,
  detail: Record<string, unknown>,
  createdAt: string
): AuditEvent {
  return {
    id: `0189${createdAt.slice(8, 10)}00-0000-7000-8000-000000000001`,
    actor: { kind: 'system', id: null },
    action: 'order.status_changed',
    entityRef: { type: 'order', id: orderId },
    detail,
    createdAt: new Date(createdAt),
  };
}

const notImplemented = () => Promise.reject(new Error('not implemented in this test'));

function makeDeps(overrides: {
  errorOrders?: Order[];
  counts?: Partial<Record<Order['status'], number>>;
  trails?: Record<string, AuditEvent[]>;
  failedNotifications?: NotificationLogEntry[];
}): ErrorQueueServiceDeps & { listByStatuses: ReturnType<typeof vi.fn> } {
  const errorOrders = overrides.errorOrders ?? [];
  const listByStatuses = vi.fn(async (query: { statuses: readonly Order['status'][] }) => {
    const items = errorOrders.filter((order) => query.statuses.includes(order.status));
    return { items, total: items.length };
  });
  const orders = {
    insert: notImplemented,
    findById: notImplemented,
    findItems: notImplemented,
    findSessions: notImplemented,
    updateStatus: notImplemented,
    setPaymentProvider: notImplemented,
    list: notImplemented,
    listByStatuses,
    countByStatuses: async () => overrides.counts ?? {},
  } as unknown as OrderRepository;

  const clients: ClientRepository = {
    async listAll() {
      return [];
    },
    async findByIds(ids) {
      const summary: ClientSummary = {
        id: CLIENT_ID,
        organizationId: '01890000-0000-7000-8000-0000000000a1',
        clientNumber: 7,
        name: 'Acme Talent',
        defaultCurrency: 'EUR',
      };
      return ids.includes(CLIENT_ID) ? [summary] : [];
    },
    async listByOrganizationIds() {
      return [];
    },
  };

  const products = {
    async findById(id: string) {
      return id === PRODUCT_ID ? ({ id: PRODUCT_ID, name: 'Insight 360' } as Product) : null;
    },
  } as unknown as ProductRepository;

  const audit = {
    record: notImplemented,
    async listByEntity(ref: { id: string }) {
      return ok({ items: overrides.trails?.[ref.id] ?? [], hasMore: false });
    },
  } as unknown as AuditService;

  const notificationLog = {
    async listByStatuses() {
      return overrides.failedNotifications ?? [];
    },
  } as unknown as NotificationLogRepository;

  return { orders, notificationLog, clients, products, audit, listByStatuses };
}

describe('retryEventForErrorStatus', () => {
  it('maps every error state to its spec-06 retry event', () => {
    expect(retryEventForErrorStatus('payment_error')).toBe('retry_payment');
    expect(retryEventForErrorStatus('email_error')).toBe('retry_email');
    expect(retryEventForErrorStatus('scoring_error')).toBe('retry_scoring');
  });
});

describe('errorQueueService.list', () => {
  it('rejects every caller who is not super_admin or system', async () => {
    const service = createErrorQueueService(makeDeps({}));
    for (const caller of [clientAdmin, assessmentAdmin, apiKeyCaller]) {
      const result = await service.list(caller, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('error_queue/forbidden');
    }
  });

  it('returns decorated entries with retry event, names, entered-at and retry count', async () => {
    const order = fixtureOrder();
    const deps = makeDeps({
      errorOrders: [order],
      trails: {
        [ORDER_A]: [
          // Newest first (audit repo contract): current failure, a prior
          // retry, and the original failure.
          statusChanged(ORDER_A, { from: 'pending', to: 'payment_error', event: 'payment_failed' }, '2026-07-10T09:00:00Z'),
          statusChanged(ORDER_A, { from: 'payment_error', to: 'pending', event: 'retry_payment' }, '2026-07-09T08:00:00Z'),
          statusChanged(ORDER_A, { from: 'pending', to: 'payment_error', event: 'payment_failed' }, '2026-07-08T07:00:00Z'),
        ],
      },
    });
    const service = createErrorQueueService(deps);

    const result = await service.list(superAdmin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(1);
    const entry = result.value.items[0]!;
    expect(entry.order.id).toBe(ORDER_A);
    expect(entry.clientName).toBe('Acme Talent');
    expect(entry.productName).toBe('Insight 360');
    expect(entry.retryEvent).toBe('retry_payment');
    // Entered-at is the NEWEST transition into the current state.
    expect(entry.enteredErrorAt).toEqual(new Date('2026-07-10T09:00:00Z'));
    expect(entry.retryCount).toBe(1);
  });

  it('queries all three error states by default and a single state when filtered', async () => {
    const deps = makeDeps({ errorOrders: [] });
    const service = createErrorQueueService(deps);

    await service.list(superAdmin, {});
    expect(deps.listByStatuses).toHaveBeenLastCalledWith(
      expect.objectContaining({
        statuses: ['payment_error', 'email_error', 'scoring_error'],
        limit: 20,
        offset: 0,
      })
    );

    await service.list(system, { status: 'scoring_error', page: 2, pageSize: 10 });
    expect(deps.listByStatuses).toHaveBeenLastCalledWith(
      expect.objectContaining({ statuses: ['scoring_error'], limit: 10, offset: 10 })
    );
  });

  it('falls back to updatedAt / zero retries when the audit trail is empty', async () => {
    const order = fixtureOrder({ id: ORDER_B, status: 'email_error', errorDetail: null });
    const service = createErrorQueueService(makeDeps({ errorOrders: [order] }));

    const result = await service.list(superAdmin, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.items[0]!;
    expect(entry.retryEvent).toBe('retry_email');
    expect(entry.enteredErrorAt).toEqual(order.updatedAt);
    expect(entry.retryCount).toBe(0);
  });

  it('rejects malformed queries with a typed validation error', async () => {
    const service = createErrorQueueService(makeDeps({}));
    const result = await service.list(superAdmin, { status: 'on_hold' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('error_queue/validation');
  });
});

describe('errorQueueService.countOpen', () => {
  it('zero-fills missing statuses and sums the total', async () => {
    const service = createErrorQueueService(
      makeDeps({ counts: { payment_error: 2, scoring_error: 1 } })
    );
    const result = await service.countOpen(superAdmin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      total: 3,
      byStatus: { payment_error: 2, email_error: 0, scoring_error: 1 },
    });
  });

  it('is forbidden for non-super-admin users', async () => {
    const service = createErrorQueueService(makeDeps({}));
    const result = await service.countOpen(clientAdmin);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('error_queue/forbidden');
  });
});

describe('errorQueueService.listFailedNotifications', () => {
  const failed: NotificationLogEntry = {
    id: '01890000-0000-7000-8000-0000000000ff',
    orderId: ORDER_A,
    sessionId: null,
    kind: 'invitation',
    recipient: 'respondent@example.com',
    template: 'invitation',
    language: 'en',
    providerMessageId: null,
    status: 'failed',
    createdAt: new Date('2026-07-10T10:00:00Z'),
    updatedAt: new Date('2026-07-10T10:00:00Z'),
  };

  it('returns recent failed/bounced entries for super admins', async () => {
    const service = createErrorQueueService(makeDeps({ failedNotifications: [failed] }));
    const result = await service.listFailedNotifications(superAdmin, {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([failed]);
  });

  it('is forbidden for client-scoped callers (recipient addresses are cross-client PII)', async () => {
    const service = createErrorQueueService(makeDeps({ failedNotifications: [failed] }));
    const result = await service.listFailedNotifications(clientAdmin, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('error_queue/forbidden');
  });

  it('rejects an out-of-range limit', async () => {
    const service = createErrorQueueService(makeDeps({}));
    const result = await service.listFailedNotifications(superAdmin, { limit: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('error_queue/validation');
  });
});
