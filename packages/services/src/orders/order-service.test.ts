import {
  err,
  ok,
  systemCallerContext,
  type CallerContext,
  type Order,
  type OrderItem,
  type Product,
  type RoleAssignment,
} from '@assessify/domain';
import type {
  ClientProductAccessRepository,
  ClientRepository,
  ClientSummary,
  NewOrderItem,
  NewOrderSession,
  OrderRepository,
  ProductPriceRepository,
  ProductRepository,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import { createOrderService } from './order-service';

const CLIENT_ID = '33333333-3333-7333-8333-333333333333';
const OTHER_CLIENT_ID = '44444444-4444-7444-8444-444444444444';
const PRODUCT_ID = '55555555-5555-7555-8555-555555555555';
const ORG_ID = '01890000-0000-7000-8000-0000000000a1';
const OTHER_ORG_ID = '01890000-0000-7000-8000-0000000000a2';
const QV_ID = '66666666-6666-7666-8666-666666666666';
const ORDER_ID = '01890000-0000-7000-8000-000000000042';

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
const otherClientAdmin: CallerContext = {
  kind: 'user',
  id: '99999999-9999-7999-8999-999999999999',
  roles: [assignment('client_admin', { clientId: OTHER_CLIENT_ID })],
};
const orderingClientUser: CallerContext = {
  kind: 'user',
  id: '77777777-7777-7777-8777-777777777777',
  roles: [
    assignment('client_user', {
      clientId: CLIENT_ID,
      permissions: {
        products: 'all',
        groups: 'all',
        canPlaceOrders: true,
        canViewResults: false,
        canReleaseReports: false,
      },
    }),
  ],
};
const system = systemCallerContext();

function fixtureOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    reference: 'ORD-00042',
    type: 'named',
    status: 'draft',
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
    placedByUserId: clientAdmin.id,
    placedVia: 'admin',
    errorDetail: null,
    source: 'native',
    legacyId: null,
    approvedAt: null,
    sentAt: null,
    completedAt: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

/** In-memory fake implementing the repository port. */
function makeRepo(seed: Order[] = []) {
  const rows = new Map<string, Order>(seed.map((o) => [o.id, o]));
  const itemRows = new Map<string, OrderItem[]>();
  const sessionRows = new Map<string, NewOrderSession[]>();
  let nextRef = 43;
  const repo: OrderRepository = {
    async insert(order, items: NewOrderItem[], sessions: NewOrderSession[]) {
      const created: Order = { ...order, reference: `ORD-${String(nextRef++).padStart(5, '0')}` };
      rows.set(created.id, created);
      itemRows.set(
        created.id,
        items.map((item) => ({ ...item, orderId: created.id }))
      );
      sessionRows.set(created.id, sessions);
      return created;
    },
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async findItems(orderId) {
      return itemRows.get(orderId) ?? [];
    },
    async findSessions(orderId) {
      return (sessionRows.get(orderId) ?? []).map((session) => ({
        id: session.id,
        orderId,
        respondentId: session.respondent.id,
        status: 'created' as const,
        isFocal: true,
        language: session.language,
        invitedAt: null,
        startedAt: null,
        completedAt: null,
        reminderCount: 0,
        lastReminderAt: null,
        remindersSuppressed: false,
        createdAt: session.createdAt,
        respondent: {
          email: session.respondent.email,
          firstName: session.respondent.firstName,
          lastName: session.respondent.lastName,
        },
      }));
    },
    async updateStatus(id, expectedStatus, patch) {
      const existing = rows.get(id);
      if (!existing || existing.status !== expectedStatus) return null;
      const updated: Order = { ...existing, ...patch };
      rows.set(id, updated);
      return updated;
    },
    async setPaymentProvider(id, provider) {
      const existing = rows.get(id);
      if (existing) rows.set(id, { ...existing, paymentProvider: provider });
    },
    async list(query) {
      let items = [...rows.values()];
      if (query.clientId) items = items.filter((o) => o.clientId === query.clientId);
      if (query.productId) items = items.filter((o) => o.productId === query.productId);
      if (query.organizationId) {
        // Mirrors the SQL products-subquery: only PRODUCT_ID belongs to ORG_ID.
        items = items.filter(
          (o) => query.organizationId === ORG_ID && o.productId === PRODUCT_ID
        );
      }
      if (query.status) items = items.filter((o) => o.status === query.status);
      if (query.type) items = items.filter((o) => o.type === query.type);
      return { items: items.slice(query.offset, query.offset + query.limit), total: items.length };
    },
    async listByStatuses(query) {
      const items = [...rows.values()].filter((o) => query.statuses.includes(o.status));
      return { items: items.slice(query.offset, query.offset + query.limit), total: items.length };
    },
    async countByStatuses(statuses) {
      const counts: Partial<Record<Order['status'], number>> = {};
      for (const order of rows.values()) {
        if (statuses.includes(order.status)) counts[order.status] = (counts[order.status] ?? 0) + 1;
      }
      return counts;
    },
  };
  return { repo, rows, sessionRows };
}

/**
 * Product resolver double: the order's product (PRODUCT_ID) belongs to
 * ORG_ID with open default access and no retail price unless overridden —
 * enough for the org-scoped visibility checks and the M3 create invariants.
 */
function makeProductsRepo(overrides: Partial<Product> = {}): ProductRepository {
  const product = {
    id: PRODUCT_ID,
    organizationId: ORG_ID,
    defaultAccess: true,
    retailPrice: null,
    retailCurrency: null,
    ...overrides,
  } as Product;
  return {
    async findById(id: string) {
      return id === product.id ? product : null;
    },
    findBySlug: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
  } as unknown as ProductRepository;
}

/** Client directory double: CLIENT_ID lives in ORG_ID, OTHER_CLIENT_ID elsewhere. */
function makeClientsRepo(): ClientRepository {
  const summaries: ClientSummary[] = [
    { id: CLIENT_ID, organizationId: ORG_ID, clientNumber: 1, name: 'Acme', defaultCurrency: 'EUR' },
    {
      id: OTHER_CLIENT_ID,
      organizationId: OTHER_ORG_ID,
      clientNumber: 2,
      name: 'Umbrella',
      defaultCurrency: 'EUR',
    },
  ];
  return {
    async listAll() {
      return summaries;
    },
    async findByIds(ids) {
      return summaries.filter((client) => ids.includes(client.id));
    },
    async listByOrganizationIds(organizationIds) {
      return summaries.filter((client) => organizationIds.includes(client.organizationId));
    },
    // Not exercised here — O1's client management flows have their own
    // client-service.test.ts.
    async findById() {
      return null;
    },
    insert: vi.fn(),
    update: vi.fn(),
  };
}

function makeAccessRepo(
  grants: { clientId: string; productId: string }[] = []
): ClientProductAccessRepository {
  return {
    grant: vi.fn(),
    revoke: vi.fn(),
    listByProduct: vi.fn(),
    async listByClient(clientId: string) {
      return grants
        .filter((grant) => grant.clientId === clientId)
        .map((grant) => ({ ...grant, createdAt: new Date('2026-07-01T00:00:00Z') }));
    },
  } as unknown as ClientProductAccessRepository;
}

/** Default price list: (en, EUR) → 15000, matching `createInput`'s line price. */
const DEFAULT_PRICES = [{ language: 'en', currency: 'EUR', unitPrice: 15000 }];

function makePricesRepo(
  rows: { language: string; currency: string; unitPrice: number }[] = DEFAULT_PRICES
): ProductPriceRepository {
  return {
    async listByProduct(productId: string) {
      return rows.map((row, index) => ({
        id: `01890000-0000-7000-8000-00000000pr${index}`,
        productId,
        ...row,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: new Date('2026-07-01T00:00:00Z'),
      }));
    },
    upsert: vi.fn(),
    delete: vi.fn(),
  } as unknown as ProductPriceRepository;
}

function makeAudit(): AuditService {
  return {
    record: vi.fn(async (actor, action, entityRef, detail) =>
      ok({
        id: '01890000-0000-7000-8000-00000000aaaa',
        actor,
        action,
        entityRef,
        detail: detail ?? {},
        createdAt: new Date('2026-07-14T12:00:00Z'),
      })
    ),
    listByEntity: vi.fn(),
  } as unknown as AuditService;
}

interface ServiceOptions {
  product?: Partial<Product>;
  prices?: { language: string; currency: string; unitPrice: number }[];
  grants?: { clientId: string; productId: string }[];
}

function makeService(seed: Order[] = [], options: ServiceOptions = {}) {
  const { repo, rows, sessionRows } = makeRepo(seed);
  const audit = makeAudit();
  const service = createOrderService({
    orders: repo,
    products: makeProductsRepo(options.product),
    clients: makeClientsRepo(),
    clientProductAccess: makeAccessRepo(options.grants),
    productPrices: makePricesRepo(options.prices),
    audit,
    now: () => new Date('2026-07-14T12:00:00Z'),
  });
  return { service, rows, sessionRows, audit };
}

function respondent(n: number) {
  return {
    firstName: `First${n}`,
    lastName: `Last${n}`,
    email: `respondent${n}@example.com`,
  };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    type: 'named',
    clientId: CLIENT_ID,
    productId: PRODUCT_ID,
    questionnaireVersionId: QV_ID,
    currency: 'EUR',
    items: [{ description: 'PRO-D assessment', unitPrice: 15000 }],
    respondents: [respondent(1)],
    ...overrides,
  };
}

describe('orderService.create', () => {
  it('creates a draft named order with pricing snapshot and audit event', async () => {
    const { service, audit } = makeService();
    const result = await service.create(clientAdmin, createInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('draft');
    expect(result.value.reference).toMatch(/^ORD-\d{5}$/);
    expect(result.value.subtotal).toBe(15000);
    expect(result.value.discountTotal).toBe(0);
    expect(result.value.total).toBe(15000);
    expect(result.value.placedByUserId).toBe(clientAdmin.id);
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: clientAdmin.id },
      'order.created',
      { type: 'order', id: result.value.id },
      expect.objectContaining({ orderType: 'named', total: 15000 })
    );
  });

  it('computes totals across bulk_named lines (integer minor units)', async () => {
    const { service } = makeService();
    const result = await service.create(
      superAdmin,
      createInput({
        type: 'bulk_named',
        items: [
          { description: 'Assessment ×10', unitPrice: 12000, quantity: 10, discount: 20000 },
          { description: 'Assessment ×3', unitPrice: 12000, quantity: 3 },
        ],
        respondents: Array.from({ length: 13 }, (_, i) => respondent(i + 1)),
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subtotal).toBe(156000);
    expect(result.value.discountTotal).toBe(20000);
    expect(result.value.total).toBe(136000);
  });

  it('rejects a named order covering more than one respondent', async () => {
    const { service } = makeService();
    const result = await service.create(
      superAdmin,
      createInput({
        items: [{ description: 'x', unitPrice: 100, quantity: 2 }],
        respondents: [respondent(1), respondent(2)],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('order/validation');
  });

  it('creates one respondent session per respondent with UUIDv4 tokens and no PIN yet', async () => {
    const { service, sessionRows } = makeService();
    const created = await service.create(
      superAdmin,
      createInput({
        type: 'bulk_named',
        items: [{ description: 'Assessment ×3', unitPrice: 12000, quantity: 3 }],
        respondents: [respondent(1), respondent(2), respondent(3)],
      })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const got = await service.get(superAdmin, created.value.id);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.sessions).toHaveLength(3);
    for (const session of got.value.sessions) {
      expect(session.status).toBe('created');
      expect(session.isFocal).toBe(true);
      // Language falls back to the order's report language.
      expect(session.language).toBe('en');
    }
    expect(got.value.sessions.map((s) => s.respondent?.email)).toEqual([
      'respondent1@example.com',
      'respondent2@example.com',
      'respondent3@example.com',
    ]);

    // Token rules (spec 05): UUIDv4 (random — version nibble 4), unique.
    const stored = sessionRows.get(created.value.id) ?? [];
    const tokens = stored.map((s) => s.token);
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens) {
      expect(token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    }
  });

  it('rejects a pricing/respondent mismatch (total quantity ≠ respondent count)', async () => {
    const { service } = makeService();
    const result = await service.create(
      superAdmin,
      createInput({
        type: 'bulk_named',
        items: [{ description: 'x', unitPrice: 100, quantity: 5 }],
        respondents: [respondent(1), respondent(2)],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('order/validation');
  });

  it('rejects duplicate respondent emails within one order', async () => {
    const { service } = makeService();
    const result = await service.create(
      superAdmin,
      createInput({
        type: 'bulk_named',
        items: [{ description: 'x', unitPrice: 100, quantity: 2 }],
        respondents: [
          respondent(1),
          { ...respondent(2), email: 'RESPONDENT1@example.com' }, // case-insensitive dupe
        ],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('order/validation');
  });

  it('rejects invalid respondent rows at the validation boundary', async () => {
    const { service } = makeService();
    for (const bad of [
      [],
      [{ firstName: '', lastName: 'x', email: 'a@b.co' }],
      [{ firstName: 'x', lastName: 'x', email: 'not-an-email' }],
      [{ firstName: 'x', lastName: 'x', email: 'a@b.co', language: 'Not A Tag' }],
    ]) {
      const result = await service.create(superAdmin, createInput({ respondents: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('order/validation');
    }
  });

  it('audits a respondent count but never respondent PII', async () => {
    const { service, audit } = makeService();
    const result = await service.create(clientAdmin, createInput());
    expect(result.ok).toBe(true);
    const detail = vi.mocked(audit.record).mock.calls[0]?.[3];
    expect(detail).toMatchObject({ respondentCount: 1 });
    expect(JSON.stringify(detail)).not.toContain('respondent1@example.com');
    expect(JSON.stringify(detail)).not.toContain('First1');
  });

  it('rejects order types not yet supported by D1', async () => {
    const { service } = makeService();
    const result = await service.create(superAdmin, createInput({ type: 'multi_rater' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('order/validation');
  });

  it('rejects a discount exceeding the line total', async () => {
    const { service } = makeService();
    const result = await service.create(
      superAdmin,
      createInput({ items: [{ description: 'x', unitPrice: 100, discount: 101 }] })
    );
    expect(result.ok).toBe(false);
  });

  it('allows only super_admin to apply per-line discounts', async () => {
    const { service } = makeService();
    const input = createInput({ items: [{ description: 'x', unitPrice: 100, discount: 10 }] });
    const denied = await service.create(clientAdmin, input);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('order/forbidden');
    const allowed = await service.create(superAdmin, input);
    expect(allowed.ok).toBe(true);
  });

  it('applies the spec 05 matrix: who may place orders for a client', async () => {
    const { service } = makeService();
    expect((await service.create(superAdmin, createInput())).ok).toBe(true);
    expect((await service.create(clientAdmin, createInput())).ok).toBe(true);
    expect((await service.create(orderingClientUser, createInput())).ok).toBe(true);
    expect((await service.create(system, createInput())).ok).toBe(true);

    const wrongClient = await service.create(otherClientAdmin, createInput());
    expect(wrongClient.ok).toBe(false);
    if (!wrongClient.ok) expect(wrongClient.error.code).toBe('order/forbidden');

    const noPermission = await service.create(
      { ...orderingClientUser, roles: [assignment('client_user', { clientId: CLIENT_ID })] },
      createInput()
    );
    expect(noPermission.ok).toBe(false);
  });

  it('surfaces a failed audit write as the operation error', async () => {
    const { repo } = makeRepo();
    const audit = makeAudit();
    vi.mocked(audit.record).mockResolvedValueOnce(
      err({ code: 'audit_write_failed', message: 'boom' })
    );
    const service = createOrderService({
      orders: repo,
      products: makeProductsRepo(),
      clients: makeClientsRepo(),
      clientProductAccess: makeAccessRepo(),
      productPrices: makePricesRepo(),
      audit,
    });
    const result = await service.create(superAdmin, createInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('audit_write_failed');
  });
});

describe('orderService.create — M3 invariants (org, access, price)', () => {
  const RANDOM_ID = '01890000-0000-7000-8000-00000000dead';

  it('rejects ordering another organization’s product — even for super_admin', async () => {
    const { service } = makeService();
    // OTHER_CLIENT_ID belongs to OTHER_ORG_ID; PRODUCT_ID belongs to ORG_ID.
    for (const caller of [superAdmin, otherClientAdmin]) {
      const result = await service.create(caller, createInput({ clientId: OTHER_CLIENT_ID }));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('order/product_outside_organization');
      expect(result.error.detail).toMatchObject({
        clientOrganizationId: OTHER_ORG_ID,
        productOrganizationId: ORG_ID,
      });
    }
  });

  it('rejects unknown clients and products with typed errors', async () => {
    const { service } = makeService();
    const noClient = await service.create(superAdmin, createInput({ clientId: RANDOM_ID }));
    expect(noClient.ok).toBe(false);
    if (!noClient.ok) expect(noClient.error.code).toBe('order/client_not_found');

    const noProduct = await service.create(superAdmin, createInput({ productId: RANDOM_ID }));
    expect(noProduct.ok).toBe(false);
    if (!noProduct.ok) expect(noProduct.error.code).toBe('order/product_not_found');
  });

  it('rejects restricted products (default_access=false) without a grant — even for super_admin', async () => {
    const { service } = makeService([], { product: { defaultAccess: false } });
    for (const caller of [clientAdmin, superAdmin]) {
      const result = await service.create(caller, createInput());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('order/product_not_available_to_client');
    }
  });

  it('accepts restricted products when the client holds an access grant', async () => {
    const { service } = makeService([], {
      product: { defaultAccess: false },
      grants: [{ clientId: CLIENT_ID, productId: PRODUCT_ID }],
    });
    const result = await service.create(clientAdmin, createInput());
    expect(result.ok).toBe(true);
  });

  it('ignores another client’s grant for the restricted product', async () => {
    const { service } = makeService([], {
      product: { defaultAccess: false },
      grants: [{ clientId: OTHER_CLIENT_ID, productId: PRODUCT_ID }],
    });
    const result = await service.create(clientAdmin, createInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('order/product_not_available_to_client');
  });

  it('holds non-super-admin callers to the resolved price list price', async () => {
    const { service } = makeService();
    const result = await service.create(
      clientAdmin,
      createInput({ items: [{ description: 'x', unitPrice: 14999 }] })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('order/price_mismatch');
    expect(result.error.detail).toMatchObject({
      expectedUnitPrice: 15000,
      priceSource: 'price_list',
      language: 'en',
      currency: 'EUR',
    });
  });

  it('lets super_admin manually override the unit price', async () => {
    const { service } = makeService();
    const result = await service.create(
      superAdmin,
      createInput({ items: [{ description: 'x', unitPrice: 100 }] })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.total).toBe(100);
  });

  it('resolves the price per language edition (report language)', async () => {
    const { service } = makeService([], {
      prices: [
        { language: 'en', currency: 'EUR', unitPrice: 15000 },
        { language: 'fr', currency: 'EUR', unitPrice: 15500 },
      ],
    });
    const ok1 = await service.create(
      clientAdmin,
      createInput({
        reportLanguage: 'fr',
        items: [{ description: 'x', unitPrice: 15500 }],
      })
    );
    expect(ok1.ok).toBe(true);

    const wrong = await service.create(
      clientAdmin,
      createInput({ reportLanguage: 'fr' }) // 15000 is the en price
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('order/price_mismatch');
  });

  it('rejects unpriced (language, currency) pairs for non-super-admins only', async () => {
    const { service } = makeService();
    for (const input of [
      createInput({ reportLanguage: 'de' }), // language without a price row
      createInput({ currency: 'USD' }), // currency without a price row
    ]) {
      const denied = await service.create(clientAdmin, input);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('order/no_price_for_language');

      // super_admin manual pricing remains possible for unpriced pairs.
      const overridden = await service.create(superAdmin, input);
      expect(overridden.ok).toBe(true);
    }
  });

  it('falls back to the retail price when the currency matches', async () => {
    const options: ServiceOptions = {
      prices: [],
      product: { retailPrice: 13000, retailCurrency: 'EUR' },
    };
    const { service } = makeService([], options);
    const matching = await service.create(
      clientAdmin,
      createInput({ items: [{ description: 'x', unitPrice: 13000 }] })
    );
    expect(matching.ok).toBe(true);

    const { service: service2 } = makeService([], options);
    const wrongCurrency = await service2.create(
      clientAdmin,
      createInput({ currency: 'USD', items: [{ description: 'x', unitPrice: 13000 }] })
    );
    expect(wrongCurrency.ok).toBe(false);
    if (!wrongCurrency.ok) expect(wrongCurrency.error.code).toBe('order/no_price_for_language');
  });

  it('rejects unpriced orders from system callers too (no silent bypass)', async () => {
    const { service } = makeService([], { prices: [] });
    const result = await service.create(system, createInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('order/no_price_for_language');
  });
});

describe('orderService.transition', () => {
  it('walks the full happy path draft → completed, auditing every step', async () => {
    const { service, audit } = makeService([fixtureOrder()]);
    const steps: Array<[CallerContext, string, string]> = [
      [clientAdmin, 'submit', 'pending'],
      [system, 'payment_succeeded', 'approved'],
      [system, 'invitations_sent', 'sent'],
      [system, 'completion_rule_met', 'processing_report'],
      [system, 'reports_ready', 'completed'],
    ];
    for (const [caller, event, expected] of steps) {
      const result = await service.transition(caller, ORDER_ID, { event });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe(expected);
    }
    // One audit entry per state change — the spec 00 hard rule.
    expect(audit.record).toHaveBeenCalledTimes(steps.length);
    expect(audit.record).toHaveBeenLastCalledWith(
      { kind: 'system', id: 'system' },
      'order.status_changed',
      { type: 'order', id: ORDER_ID },
      expect.objectContaining({ from: 'processing_report', to: 'completed', event: 'reports_ready' })
    );
  });

  it('stamps approved/sent/completed timestamps on first entry only', async () => {
    const { service, rows } = makeService([fixtureOrder()]);
    await service.transition(clientAdmin, ORDER_ID, { event: 'submit' });
    await service.transition(system, ORDER_ID, { event: 'payment_succeeded' });
    await service.transition(system, ORDER_ID, { event: 'invitations_sent' });
    await service.transition(system, ORDER_ID, { event: 'completion_rule_met' });
    await service.transition(system, ORDER_ID, { event: 'reports_ready' });
    const completed = rows.get(ORDER_ID);
    expect(completed?.approvedAt).toEqual(new Date('2026-07-14T12:00:00Z'));
    expect(completed?.sentAt).toEqual(new Date('2026-07-14T12:00:00Z'));
    const firstCompletedAt = completed?.completedAt;
    expect(firstCompletedAt).not.toBeNull();

    // resend_email round trip must not overwrite completed_at.
    await service.transition(superAdmin, ORDER_ID, { event: 'resend_email' });
    await service.transition(system, ORDER_ID, { event: 'resend_completed' });
    expect(rows.get(ORDER_ID)?.completedAt).toEqual(firstCompletedAt);
    expect(rows.get(ORDER_ID)?.status).toBe('completed');
  });

  it('rejects illegal transitions with a typed error listing legal events', async () => {
    const { service } = makeService([fixtureOrder({ status: 'completed' })]);
    const result = await service.transition(superAdmin, ORDER_ID, { event: 'submit' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('order/illegal_transition');
    expect(result.error.detail).toMatchObject({
      from: 'completed',
      event: 'submit',
      legalEvents: expect.arrayContaining(['refund', 'resend_email', 'hold']),
    });
  });

  it('rejects any event on terminal orders', async () => {
    const { service } = makeService([fixtureOrder({ status: 'cancelled' })]);
    for (const event of ['submit', 'hold', 'cancel', 'refund'] as const) {
      const result = await service.transition(superAdmin, ORDER_ID, { event });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('order/illegal_transition');
    }
  });

  it('enforces required actors: retries are super_admin only', async () => {
    const { service } = makeService([fixtureOrder({ status: 'payment_error' })]);
    const denied = await service.transition(clientAdmin, ORDER_ID, { event: 'retry_payment' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('order/forbidden');

    const allowed = await service.transition(superAdmin, ORDER_ID, { event: 'retry_payment' });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.value.status).toBe('pending');
  });

  it('client roles only act on their own client’s orders', async () => {
    const { service } = makeService([fixtureOrder()]);
    // Wrong-client admin cannot even see the order → not_found, not forbidden.
    const result = await service.transition(otherClientAdmin, ORDER_ID, { event: 'submit' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('order/not_found');
  });

  it('system cannot trigger admin-only transitions', async () => {
    const { service } = makeService([fixtureOrder({ status: 'sent' })]);
    const result = await service.transition(system, ORDER_ID, { event: 'cancel' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('order/forbidden');
  });

  it('populates error_detail on failure events and clears it on retry', async () => {
    const { service, rows } = makeService([fixtureOrder({ status: 'pending' })]);
    const failed = await service.transition(system, ORDER_ID, {
      event: 'payment_failed',
      errorDetail: { provider: 'stripe', declineCode: 'card_declined' },
    });
    expect(failed.ok).toBe(true);
    expect(rows.get(ORDER_ID)?.errorDetail).toEqual({
      provider: 'stripe',
      declineCode: 'card_declined',
    });

    await service.transition(superAdmin, ORDER_ID, { event: 'retry_payment' });
    expect(rows.get(ORDER_ID)?.errorDetail).toBeNull();
  });

  it('hold stores the previous status and release restores it', async () => {
    const { service, rows } = makeService([fixtureOrder({ status: 'sent' })]);
    const held = await service.transition(superAdmin, ORDER_ID, {
      event: 'hold',
      reason: 'client dispute',
    });
    expect(held.ok).toBe(true);
    if (held.ok) expect(held.value.status).toBe('on_hold');
    expect(rows.get(ORDER_ID)?.errorDetail).toEqual({
      previousStatus: 'sent',
      reason: 'client dispute',
    });

    const released = await service.transition(superAdmin, ORDER_ID, { event: 'release' });
    expect(released.ok).toBe(true);
    if (released.ok) expect(released.value.status).toBe('sent');
    expect(rows.get(ORDER_ID)?.errorDetail).toBeNull();
  });

  it('hold from an error state preserves and restores the error detail', async () => {
    const { service, rows } = makeService([
      fixtureOrder({ status: 'scoring_error', errorDetail: { adapter: 'timeout' } }),
    ]);
    await service.transition(superAdmin, ORDER_ID, { event: 'hold' });
    expect(rows.get(ORDER_ID)?.errorDetail).toEqual({
      previousStatus: 'scoring_error',
      heldErrorDetail: { adapter: 'timeout' },
    });
    const released = await service.transition(superAdmin, ORDER_ID, { event: 'release' });
    expect(released.ok).toBe(true);
    if (released.ok) expect(released.value.status).toBe('scoring_error');
    expect(rows.get(ORDER_ID)?.errorDetail).toEqual({ adapter: 'timeout' });
  });

  it('rejects release when no valid previous status was recorded', async () => {
    const { service } = makeService([fixtureOrder({ status: 'on_hold', errorDetail: null })]);
    const result = await service.transition(superAdmin, ORDER_ID, { event: 'release' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('order/invalid_hold_state');
  });

  it('reports a conflict when the order was transitioned concurrently', async () => {
    const { service, rows } = makeService([fixtureOrder()]);
    const original = rows.get(ORDER_ID);
    if (!original) throw new Error('seed missing');
    // Simulate a concurrent writer flipping the status after the read: the
    // fake repo compares expectedStatus at update time, so mutate directly.
    const sneaky = { ...original, status: 'cancelled' as const };
    const promise = service.transition(clientAdmin, ORDER_ID, { event: 'submit' });
    rows.set(ORDER_ID, sneaky);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('order/conflict');
  });

  it('returns not_found for unknown or malformed order ids', async () => {
    const { service } = makeService();
    const missing = await service.transition(superAdmin, ORDER_ID, { event: 'submit' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('order/not_found');
    const malformed = await service.transition(superAdmin, 'ORD-00042', { event: 'submit' });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('order/not_found');
  });

  it('rejects unknown events at the validation boundary', async () => {
    const { service } = makeService([fixtureOrder()]);
    const result = await service.transition(superAdmin, ORDER_ID, { event: 'approve' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('order/validation');
  });

  it('surfaces a failed audit write after a transition', async () => {
    const { repo } = makeRepo([fixtureOrder()]);
    const audit = makeAudit();
    vi.mocked(audit.record).mockResolvedValueOnce(
      err({ code: 'audit_write_failed', message: 'boom' })
    );
    const service = createOrderService({
      orders: repo,
      products: makeProductsRepo(),
      clients: makeClientsRepo(),
      clientProductAccess: makeAccessRepo(),
      productPrices: makePricesRepo(),
      audit,
    });
    const result = await service.transition(superAdmin, ORDER_ID, { event: 'submit' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('audit_write_failed');
  });
});

describe('orderService.get / list', () => {
  it('returns the order with its items to authorized callers', async () => {
    const { service } = makeService();
    const created = await service.create(clientAdmin, createInput());
    if (!created.ok) throw new Error('create failed');
    const result = await service.get(clientAdmin, created.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0]).toMatchObject({
      lineNo: 1,
      description: 'PRO-D assessment',
      unitPrice: 15000,
    });
  });

  it('hides orders from out-of-scope callers as not_found', async () => {
    const { service } = makeService([fixtureOrder()]);
    const result = await service.get(otherClientAdmin, ORDER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('order/not_found');
  });

  it('assessment_admin can read orders for their organization’s products only', async () => {
    const { service } = makeService([fixtureOrder()]);
    const owner: CallerContext = {
      kind: 'user',
      id: '88888888-8888-7888-8888-888888888888',
      roles: [assignment('assessment_admin', { organizationId: ORG_ID })],
    };
    expect((await service.get(owner, ORDER_ID)).ok).toBe(true);
    const other: CallerContext = {
      ...owner,
      roles: [assignment('assessment_admin', { organizationId: OTHER_ORG_ID })],
    };
    expect((await service.get(other, ORDER_ID)).ok).toBe(false);
  });

  it('lists orders for super_admin and scoped clients', async () => {
    const { service } = makeService([
      fixtureOrder(),
      fixtureOrder({ id: '01890000-0000-7000-8000-000000000043', clientId: OTHER_CLIENT_ID }),
    ]);
    const all = await service.list(superAdmin, {});
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.value.total).toBe(2);

    const scoped = await service.list(clientAdmin, { clientId: CLIENT_ID });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(scoped.value.total).toBe(1);

    const unscoped = await service.list(clientAdmin, {});
    expect(unscoped.ok).toBe(false);
    if (!unscoped.ok) expect(unscoped.error.code).toBe('order/forbidden');

    const wrongScope = await service.list(clientAdmin, { clientId: OTHER_CLIENT_ID });
    expect(wrongScope.ok).toBe(false);
  });

  it('lists orders for org-scoped assessment_admins by organizationId (M2)', async () => {
    const { service } = makeService([
      fixtureOrder(),
      fixtureOrder({
        id: '01890000-0000-7000-8000-000000000043',
        productId: OTHER_CLIENT_ID, // a product of some other org
      }),
    ]);
    const orgAdmin: CallerContext = {
      kind: 'user',
      id: '88888888-8888-7888-8888-888888888888',
      roles: [assignment('assessment_admin', { organizationId: ORG_ID })],
    };

    const scoped = await service.list(orgAdmin, { organizationId: ORG_ID });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(scoped.value.items.map((o) => o.id)).toEqual([ORDER_ID]);

    const unscoped = await service.list(orgAdmin, {});
    expect(unscoped.ok).toBe(false);

    const wrongOrg = await service.list(orgAdmin, { organizationId: OTHER_ORG_ID });
    expect(wrongOrg.ok).toBe(false);
    if (!wrongOrg.ok) expect(wrongOrg.error.code).toBe('order/forbidden');
  });
});

describe('orderService.history', () => {
  it('returns the audit trail for viewable orders', async () => {
    const { service, audit } = makeService([fixtureOrder()]);
    vi.mocked(audit.listByEntity).mockResolvedValueOnce(ok({ items: [], hasMore: false }));
    const result = await service.history(clientAdmin, ORDER_ID);
    expect(result.ok).toBe(true);
    expect(audit.listByEntity).toHaveBeenCalledWith(
      { type: 'order', id: ORDER_ID },
      { limit: 100 }
    );
  });

  it('hides history from out-of-scope callers as not_found', async () => {
    const { service, audit } = makeService([fixtureOrder()]);
    const result = await service.history(otherClientAdmin, ORDER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('order/not_found');
    expect(audit.listByEntity).not.toHaveBeenCalled();
  });
});
