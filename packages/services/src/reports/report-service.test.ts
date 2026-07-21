import {
  ok,
  UPLOADED_HTML_COMPONENT_KEY,
  type CallerContext,
  type Order,
  type Product,
  type RoleAssignment,
} from '@assessify/domain';
import { MemoryStorage } from '@assessify/adapters/storage/memory';
import type { PdfRenderer } from '@assessify/adapters';
import type {
  ReportAssemblySource,
  ReportRecord,
  ReportRepository,
  ReportTemplateVersion,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import { canReleaseReports, createReportService, templateStorageKey } from './index';

const SESSION_ID = '01890000-0000-7000-8000-00000000aa01';
const ORDER_ID = '01890000-0000-7000-8000-00000000bb01';
const PRODUCT_ID = '01890000-0000-7000-8000-00000000cc01';
const CLIENT_ID = '01890000-0000-7000-8000-00000000dd01';
const OTHER_CLIENT_ID = '01890000-0000-7000-8000-00000000dd02';
const TEMPLATE_ID = '01890000-0000-7000-8000-00000000ee01';
const ORG_ID = '01890000-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-07-20T10:00:00Z');

const TEMPLATE_HTML =
  '<!doctype html><html><body><h1>{{t.report_title}}</h1>' +
  '<p>{{respondent.fullName}}</p><span>{{scores.dimensions.drive}}</span>{{unknown.thing}}</body></html>';

const SCORES = { dimensions: { drive: 72.5 }, bands: { drive: 'high' } };

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

function assignment(
  role: RoleAssignment['role'],
  scope: { organizationId?: string; clientId?: string } = {},
  permissions: Partial<RoleAssignment['permissions']> = {}
): RoleAssignment {
  return {
    role,
    organizationId: scope.organizationId ?? null,
    productId: null,
    clientId: scope.clientId ?? null,
    permissions: {
      products: [],
      groups: [],
      canPlaceOrders: false,
      canViewResults: false,
      canReleaseReports: false,
      ...permissions,
    },
  };
}

const superAdmin: CallerContext = { kind: 'user', id: 'admin-1', roles: [assignment('super_admin')] };
const orgAdmin: CallerContext = {
  kind: 'user',
  id: 'org-admin-1',
  roles: [assignment('assessment_admin', { organizationId: ORG_ID })],
};
const clientAdmin: CallerContext = {
  kind: 'user',
  id: 'client-admin-1',
  roles: [assignment('client_admin', { clientId: CLIENT_ID })],
};
const otherClientAdmin: CallerContext = {
  kind: 'user',
  id: 'client-admin-2',
  roles: [assignment('client_admin', { clientId: OTHER_CLIENT_ID })],
};
const releasingClientUser: CallerContext = {
  kind: 'user',
  id: 'client-user-1',
  roles: [
    assignment('client_user', { clientId: CLIENT_ID }, { canReleaseReports: true, products: 'all' }),
  ],
};
const productScopedClientUser: CallerContext = {
  kind: 'user',
  id: 'client-user-2',
  roles: [
    assignment(
      'client_user',
      { clientId: CLIENT_ID },
      { canReleaseReports: true, products: [PRODUCT_ID] }
    ),
  ],
};
const powerlessClientUser: CallerContext = {
  kind: 'user',
  id: 'client-user-3',
  roles: [assignment('client_user', { clientId: CLIENT_ID }, { canViewResults: true })],
};
const respondentCaller: CallerContext = { kind: 'respondent', id: SESSION_ID, roles: [] };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixtureProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    organizationId: ORG_ID,
    slug: 'pro-d',
    name: 'PRO-D',
    status: 'active',
    defaultAccess: true,
    branding: {},
    defaultLanguage: 'en',
    availableLanguages: ['en'],
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fixtureOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    reference: 'ORD-00042',
    type: 'named',
    status: 'processing_report',
    clientId: CLIENT_ID,
    productId: PRODUCT_ID,
    questionnaireVersionId: '01890000-0000-7000-8000-00000000ff01',
    reportTemplateVersionId: null,
    reportLanguage: 'en',
    reportModel: 'individual',
    currency: 'EUR',
    subtotal: 0,
    discountTotal: 0,
    total: 0,
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
    errorDetail: null,
    source: 'native',
    legacyId: null,
    approvedAt: null,
    sentAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fixtureTemplate(overrides: Partial<ReportTemplateVersion> = {}): ReportTemplateVersion {
  return {
    id: TEMPLATE_ID,
    productId: PRODUCT_ID,
    version: 1,
    componentKey: UPLOADED_HTML_COMPONENT_KEY,
    config: {
      storageKey: templateStorageKey(PRODUCT_ID, TEMPLATE_ID),
      contentType: 'text/html',
      capabilities: { web: true, pdf: true },
    },
    status: 'active',
    createdAt: NOW,
    ...overrides,
  };
}

function fixtureSource(overrides: Partial<ReportAssemblySource> = {}): ReportAssemblySource {
  return {
    sessionId: SESSION_ID,
    orderId: ORDER_ID,
    sessionStatus: 'scored',
    language: 'en',
    completedAt: NOW,
    scores: SCORES,
    isFocal: true,
    respondent: { firstName: 'Ada', lastName: 'Lovelace' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeReports implements ReportRepository {
  rows = new Map<string, ReportRecord>();
  source: ReportAssemblySource | null = fixtureSource();
  focalSessions = 1;

  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findBySessionId(sessionId: string) {
    return [...this.rows.values()].find((r) => r.sessionId === sessionId) ?? null;
  }
  async listByOrder(orderId: string) {
    return [...this.rows.values()].filter((r) => r.orderId === orderId);
  }
  async insert(report: ReportRecord) {
    this.rows.set(report.id, report);
    return report;
  }
  async updateAssembly(id: string, patch: { templateVersionId: string; data: Record<string, unknown>; updatedAt: Date }) {
    const row = this.rows.get(id);
    if (!row) return null;
    const updated = { ...row, ...patch };
    this.rows.set(id, updated);
    return updated;
  }
  async release(id: string, releasedBy: string, at: Date) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'ready') return null;
    const updated: ReportRecord = { ...row, status: 'released', releasedBy, releasedAt: at, updatedAt: at };
    this.rows.set(id, updated);
    return updated;
  }
  async withhold(id: string, at: Date) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'released') return null;
    const updated: ReportRecord = { ...row, status: 'ready', releasedBy: null, releasedAt: null, updatedAt: at };
    this.rows.set(id, updated);
    return updated;
  }
  async countByOrder(orderId: string, statuses: readonly string[]) {
    return [...this.rows.values()].filter(
      (r) => r.orderId === orderId && statuses.includes(r.status)
    ).length;
  }
  async countFocalSessions() {
    return this.focalSessions;
  }
  async findAssemblySource(sessionId: string) {
    return this.source && this.source.sessionId === sessionId ? this.source : null;
  }
}

function fakeAudit() {
  const record = vi.fn(async (actor, action, entityRef, detail) =>
    ok({ id: '01890000-0000-7000-8000-00000000ffff', actor, action, entityRef, detail: detail ?? {}, createdAt: NOW })
  );
  return { audit: { record, listByEntity: vi.fn() } as unknown as AuditService, record };
}

function pdfStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
      controller.close();
    },
  });
}

interface MakeOptions {
  order?: Order | null;
  product?: Product | null;
  template?: ReportTemplateVersion | null;
  templateInStorage?: boolean;
  pdf?: PdfRenderer | null;
  onReleased?: ReturnType<typeof vi.fn>;
}

async function makeService(options: MakeOptions = {}) {
  const reports = new FakeReports();
  const storage = new MemoryStorage();
  const template = options.template === undefined ? fixtureTemplate() : options.template;
  if (template && options.templateInStorage !== false) {
    await storage.upload({
      key: (template.config as { storageKey: string }).storageKey,
      body: new TextEncoder().encode(TEMPLATE_HTML),
      contentType: 'text/html',
    });
  }
  const order = options.order === undefined ? fixtureOrder() : options.order;
  const product = options.product === undefined ? fixtureProduct() : options.product;
  const { audit, record } = fakeAudit();
  const markReportReady = vi.fn(async () => true);
  const transition = vi.fn(async () => ok(order ?? fixtureOrder()));
  const resolve = vi.fn(async (_productId: string, language: string) =>
    ok({
      productId: PRODUCT_ID,
      language,
      defaultLanguage: 'en',
      strings: { report_title: 'Your PRO-D Report' },
      fallbackKeys: [],
      missingKeys: [],
    })
  );
  const pdf = options.pdf === undefined ? { render: vi.fn(async () => pdfStream()) } : options.pdf;
  const onReleased = options.onReleased ?? vi.fn(async () => undefined);

  const service = createReportService({
    reports,
    reportTemplates: {
      findById: async (id) => (template && template.id === id ? template : null),
      findActive: async (productId) =>
        template && template.productId === productId && template.status === 'active'
          ? template
          : null,
    },
    sessions: { markReportReady },
    orders: { findById: async (id) => (order && order.id === id ? order : null) },
    products: { findById: async (id) => (product && product.id === id ? product : null) },
    translations: { resolve },
    orderService: { transition },
    audit,
    storage,
    ...(pdf ? { pdf } : {}),
    onReleased,
    now: () => NOW,
    generateId: () => '01890000-0000-7000-8000-00000000ab01',
  });
  return { service, reports, storage, record, markReportReady, transition, resolve, pdf, onReleased };
}

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

describe('reportService.assemble', () => {
  it('merges the template, stores the HTML, persists a ready report and drives state', async () => {
    const { service, reports, storage, record, markReportReady, transition } = await makeService();

    const result = await service.assemble(SESSION_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('ready');
    expect(result.value.unknownPlaceholders).toEqual(['unknown.thing']);

    const report = reports.rows.get(result.value.reportId);
    expect(report?.status).toBe('ready');
    expect(report?.templateVersionId).toBe(TEMPLATE_ID);
    expect(report?.sessionId).toBe(SESSION_ID);

    const data = report?.data as { storageKey: string; context: { respondent: { fullName: string } } };
    expect(data.storageKey).toBe(`reports/${ORDER_ID}/${result.value.reportId}.html`);
    const stored = await storage.download(data.storageKey);
    const html = new TextDecoder().decode(stored!.body);
    expect(html).toContain('<h1>Your PRO-D Report</h1>');
    expect(html).toContain('<p>Ada Lovelace</p>');
    expect(html).toContain('<span>72.5</span>');
    expect(data.context.respondent.fullName).toBe('Ada Lovelace');

    expect(markReportReady).toHaveBeenCalledWith(SESSION_ID, NOW);
    // Single focal session with a ready report → reports_ready fired.
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'system' }),
      ORDER_ID,
      { event: 'reports_ready' }
    );
    expect(record).toHaveBeenCalledWith(
      { kind: 'system', id: 'system' },
      'report.assembled',
      { type: 'report', id: result.value.reportId },
      expect.objectContaining({ unknownPlaceholders: ['unknown.thing'] })
    );
  });

  it('does not fire reports_ready while other focal sessions are unreported', async () => {
    const { service, reports, transition } = await makeService();
    reports.focalSessions = 3;

    const result = await service.assemble(SESSION_ID);
    expect(result.ok).toBe(true);
    expect(transition).not.toHaveBeenCalled();
  });

  it('auto-releases when the product policy says so and fires the E6 hook', async () => {
    const { service, reports, record, onReleased } = await makeService({
      product: fixtureProduct({ notificationDefaults: { reportRelease: 'auto' } }),
    });

    const result = await service.assemble(SESSION_ID);
    expect(result.ok && result.value.status === 'released').toBe(true);
    if (!result.ok) return;
    expect(reports.rows.get(result.value.reportId)?.releasedBy).toBe('system');
    expect(record).toHaveBeenCalledWith(
      { kind: 'system', id: 'system' },
      'report.released',
      { type: 'report', id: result.value.reportId },
      expect.objectContaining({ mode: 'auto' })
    );
    expect(onReleased).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: result.value.reportId, mode: 'auto' })
    );
  });

  it('order-level policy overrides the product default', async () => {
    const { service } = await makeService({
      order: fixtureOrder({ notificationPolicy: { reportRelease: 'manual' } }),
      product: fixtureProduct({ notificationDefaults: { reportRelease: 'auto' } }),
    });
    const result = await service.assemble(SESSION_ID);
    expect(result.ok && result.value.status === 'ready').toBe(true);
  });

  it('fails permanently when no template is available', async () => {
    const { service } = await makeService({ template: null });
    const result = await service.assemble(SESSION_ID);
    expect(!result.ok && result.error.code === 'report/template_missing').toBe(true);
    if (result.ok) return;
    expect(result.error.detail?.['permanent']).toBe(true);
  });

  it('fails permanently for unscored sessions', async () => {
    const { service, reports } = await makeService();
    reports.source = fixtureSource({ sessionStatus: 'completed', scores: null });
    const result = await service.assemble(SESSION_ID);
    expect(!result.ok && result.error.code === 'report/session_not_scored').toBe(true);
    if (result.ok) return;
    expect(result.error.detail?.['permanent']).toBe(true);
  });

  it('fails permanently for unknown sessions and rater (non-focal) sessions', async () => {
    const { service, reports } = await makeService();
    reports.source = null;
    const missing = await service.assemble(SESSION_ID);
    expect(!missing.ok && missing.error.code === 'report/session_not_found').toBe(true);

    reports.source = fixtureSource({ isFocal: false });
    const rater = await service.assemble(SESSION_ID);
    expect(!rater.ok && rater.error.code === 'report/session_not_focal').toBe(true);
  });

  it('uses the order-pinned template version over the active one', async () => {
    const pinned = fixtureTemplate({ id: '01890000-0000-7000-8000-00000000ee02', version: 2, status: 'retired' });
    (pinned.config as { storageKey: string }).storageKey = templateStorageKey(PRODUCT_ID, pinned.id);
    const { service, reports } = await makeService({
      order: fixtureOrder({ reportTemplateVersionId: pinned.id }),
      template: pinned,
    });
    const result = await service.assemble(SESSION_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(reports.rows.get(result.value.reportId)?.templateVersionId).toBe(pinned.id);
  });
});

// ---------------------------------------------------------------------------
// reassemble
// ---------------------------------------------------------------------------

describe('reportService.reassemble', () => {
  it('refreshes an existing report without resurrecting a withheld release state', async () => {
    const { service, reports } = await makeService({
      product: fixtureProduct({ notificationDefaults: { reportRelease: 'auto' } }),
    });
    const first = await service.assemble(SESSION_ID);
    expect(first.ok && first.value.status === 'released').toBe(true);
    if (!first.ok) return;

    await service.withhold(superAdmin, first.value.reportId);
    const again = await service.reassemble(superAdmin, SESSION_ID);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.reportId).toBe(first.value.reportId);
    // Withheld stays withheld — auto-release only applies to fresh assemblies.
    expect(reports.rows.get(again.value.reportId)?.status).toBe('ready');
  });

  it('allows the product org’s assessment_admin and rejects client admins', async () => {
    const { service } = await makeService();
    const allowed = await service.reassemble(orgAdmin, SESSION_ID);
    expect(allowed.ok).toBe(true);

    const denied = await service.reassemble(clientAdmin, SESSION_ID);
    expect(!denied.ok && denied.error.code === 'report/forbidden').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// release / withhold
// ---------------------------------------------------------------------------

describe('reportService.release authz matrix (spec 05)', () => {
  async function readyReport(service: Awaited<ReturnType<typeof makeService>>['service']) {
    const assembled = await service.assemble(SESSION_ID);
    if (!assembled.ok) throw new Error('assemble failed');
    return assembled.value.reportId;
  }

  it.each([
    ['super_admin', superAdmin, true],
    ['client_admin of the order client', clientAdmin, true],
    ['client_admin of another client', otherClientAdmin, false],
    ['client_user with canReleaseReports (all products)', releasingClientUser, true],
    ['client_user with canReleaseReports (product-scoped)', productScopedClientUser, true],
    ['client_user without canReleaseReports', powerlessClientUser, false],
    ['assessment_admin', orgAdmin, false],
    ['respondent', respondentCaller, false],
  ] as const)('%s → allowed=%s', async (_label, caller, allowed) => {
    const { service } = await makeService();
    const reportId = await readyReport(service);
    const result = await service.release(caller, reportId);
    if (allowed) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('released');
    } else {
      expect(!result.ok && result.error.code === 'report/forbidden').toBe(true);
    }
  });

  it('audits the manual release, stamps the releasing user and fires the hook', async () => {
    const { service, reports, record, onReleased } = await makeService();
    const reportId = await readyReport(service);

    const result = await service.release(clientAdmin, reportId);
    expect(result.ok).toBe(true);
    expect(reports.rows.get(reportId)?.releasedBy).toBe('client-admin-1');
    expect(record).toHaveBeenCalledWith(
      { kind: 'user', id: 'client-admin-1' },
      'report.released',
      { type: 'report', id: reportId },
      expect.objectContaining({ mode: 'manual', orderId: ORDER_ID })
    );
    expect(onReleased).toHaveBeenCalledWith(expect.objectContaining({ reportId, mode: 'manual' }));

    // Idempotent re-release.
    const again = await service.release(clientAdmin, reportId);
    expect(again.ok && again.value.status === 'released').toBe(true);
  });

  it('withholds a released report (audited) and is idempotent for ready ones', async () => {
    const { service, reports, record } = await makeService();
    const reportId = await readyReport(service);
    await service.release(superAdmin, reportId);

    const withheld = await service.withhold(clientAdmin, reportId);
    expect(withheld.ok && withheld.value.status === 'ready').toBe(true);
    expect(reports.rows.get(reportId)?.releasedAt).toBeNull();
    expect(record).toHaveBeenCalledWith(
      { kind: 'user', id: 'client-admin-1' },
      'report.withheld',
      { type: 'report', id: reportId },
      expect.objectContaining({ orderId: ORDER_ID })
    );

    const again = await service.withhold(clientAdmin, reportId);
    expect(again.ok && again.value.status === 'ready').toBe(true);

    const denied = await service.withhold(powerlessClientUser, reportId);
    expect(!denied.ok && denied.error.code === 'report/forbidden').toBe(true);
  });

  it('release failures on the hook are audited but never roll back the release', async () => {
    const onReleased = vi.fn(async () => {
      throw new Error('notification exploded');
    });
    const { service, reports, record } = await makeService({ onReleased });
    const reportId = await readyReport(service);

    const result = await service.release(superAdmin, reportId);
    expect(result.ok).toBe(true);
    expect(reports.rows.get(reportId)?.status).toBe('released');
    expect(record).toHaveBeenCalledWith(
      { kind: 'system', id: 'system' },
      'report.release_hook_failed',
      { type: 'report', id: reportId },
      expect.objectContaining({ cause: 'notification exploded' })
    );
  });
});

describe('canReleaseReports', () => {
  it('denies api_key and system callers', () => {
    const order = fixtureOrder();
    expect(canReleaseReports({ kind: 'api_key', id: 'k1', roles: [] }, order)).toBe(false);
    expect(canReleaseReports({ kind: 'system', id: 'system', roles: [] }, order)).toBe(false);
  });

  it('denies client_user whose product scope excludes the order product', () => {
    const scoped: CallerContext = {
      kind: 'user',
      id: 'client-user-4',
      roles: [
        assignment(
          'client_user',
          { clientId: CLIENT_ID },
          { canReleaseReports: true, products: ['01890000-0000-7000-8000-00000000cc99'] }
        ),
      ],
    };
    expect(canReleaseReports(scoped, fixtureOrder())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// respondent view / print / pdf
// ---------------------------------------------------------------------------

describe('respondent-facing report serving', () => {
  it('serves the assembled HTML only when released, and audits the view', async () => {
    const { service, record } = await makeService();
    const assembled = await service.assemble(SESSION_ID);
    if (!assembled.ok) throw new Error('assemble failed');

    const held = await service.getRespondentReport(SESSION_ID);
    expect(!held.ok && held.error.code === 'report/not_available').toBe(true);

    await service.release(superAdmin, assembled.value.reportId);
    const view = await service.getRespondentReport(SESSION_ID);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.html).toContain('Ada Lovelace');
    expect(view.value.pdfAvailable).toBe(true);
    expect(view.value.pageSize).toBe('a4');
    expect(record).toHaveBeenCalledWith(
      { kind: 'respondent', id: SESSION_ID },
      'report.viewed',
      { type: 'report', id: assembled.value.reportId },
      expect.objectContaining({ sessionId: SESSION_ID })
    );
  });

  it('serves print HTML for ready reports (pre-release admin/pdf-service access)', async () => {
    const { service } = await makeService();
    const assembled = await service.assemble(SESSION_ID);
    if (!assembled.ok) throw new Error('assemble failed');

    const print = await service.getPrintHtml(assembled.value.reportId);
    expect(print.ok).toBe(true);
    if (!print.ok) return;
    expect(print.value.html).toContain('<span>72.5</span>');

    const missing = await service.getPrintHtml('01890000-0000-7000-8000-00000000dead');
    expect(!missing.ok && missing.error.code === 'report/not_found').toBe(true);
  });

  it('streams a PDF for released pdf-capable reports and audits the download', async () => {
    const { service, record, pdf } = await makeService();
    const assembled = await service.assemble(SESSION_ID);
    if (!assembled.ok) throw new Error('assemble failed');
    await service.release(superAdmin, assembled.value.reportId);

    const result = await service.renderPdfForSession(SESSION_ID);
    expect(result.ok).toBe(true);
    expect((pdf as { render: ReturnType<typeof vi.fn> }).render).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 'a4', html: expect.stringContaining('Ada Lovelace') })
    );
    expect(record).toHaveBeenCalledWith(
      { kind: 'respondent', id: SESSION_ID },
      'report.downloaded',
      { type: 'report', id: assembled.value.reportId },
      expect.objectContaining({ pageSize: 'a4' })
    );
  });

  it('refuses PDFs for web-only templates and when no renderer is composed', async () => {
    const webOnly = fixtureTemplate();
    (webOnly.config as { capabilities: { web: boolean; pdf: boolean } }).capabilities = {
      web: true,
      pdf: false,
    };
    const { service } = await makeService({ template: webOnly });
    const assembled = await service.assemble(SESSION_ID);
    if (!assembled.ok) throw new Error('assemble failed');
    await service.release(superAdmin, assembled.value.reportId);

    const result = await service.renderPdfForSession(SESSION_ID);
    expect(!result.ok && result.error.code === 'report/pdf_unavailable').toBe(true);

    const noRenderer = await makeService({ pdf: null });
    const assembled2 = await noRenderer.service.assemble(SESSION_ID);
    if (!assembled2.ok) throw new Error('assemble failed');
    await noRenderer.service.release(superAdmin, assembled2.value.reportId);
    const result2 = await noRenderer.service.renderPdfForSession(SESSION_ID);
    expect(!result2.ok && result2.error.code === 'report/pdf_renderer_unavailable').toBe(true);
  });
});
