import { ok, type CallerContext, type Product, type RoleAssignment } from '@assessify/domain';
import { MemoryStorage } from '@assessify/adapters/storage/memory';
import type {
  ProductRepository,
  ReportTemplateVersion,
  ReportTemplateVersionRepository,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import {
  createReportTemplateService,
  templateStorageKey,
} from './report-template-service';

const PRODUCT_ID = '01890000-0000-7000-8000-000000000001';
const ORG_ID = '01890000-0000-7000-8000-0000000000a1';
const OTHER_ORG_ID = '01890000-0000-7000-8000-0000000000a2';
const NOW = new Date('2026-07-20T10:00:00Z');

function assignment(
  role: RoleAssignment['role'],
  scope: { organizationId?: string; clientId?: string } = {}
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
    },
  };
}

const superAdmin: CallerContext = { kind: 'user', id: 'admin-1', roles: [assignment('super_admin')] };
const orgAdmin: CallerContext = {
  kind: 'user',
  id: 'org-admin-1',
  roles: [assignment('assessment_admin', { organizationId: ORG_ID })],
};
const otherOrgAdmin: CallerContext = {
  kind: 'user',
  id: 'org-admin-2',
  roles: [assignment('assessment_admin', { organizationId: OTHER_ORG_ID })],
};

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

class FakeTemplates implements ReportTemplateVersionRepository {
  rows = new Map<string, ReportTemplateVersion>();
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findActive(productId: string) {
    return (
      [...this.rows.values()].find((r) => r.productId === productId && r.status === 'active') ??
      null
    );
  }
  async listByProduct(productId: string) {
    return [...this.rows.values()]
      .filter((r) => r.productId === productId)
      .sort((a, b) => b.version - a.version);
  }
  async maxVersion(productId: string) {
    return Math.max(
      0,
      ...[...this.rows.values()].filter((r) => r.productId === productId).map((r) => r.version)
    );
  }
  async insert(version: ReportTemplateVersion) {
    this.rows.set(version.id, version);
    return version;
  }
  async updateStatus(id: string, status: ReportTemplateVersion['status']) {
    const row = this.rows.get(id);
    if (!row) return null;
    const updated = { ...row, status };
    this.rows.set(id, updated);
    return updated;
  }
}

function fakeProducts(product: Product | null = fixtureProduct()): ProductRepository {
  return {
    findById: vi.fn(async (id: string) => (product && id === product.id ? product : null)),
  } as unknown as ProductRepository;
}

function fakeAudit() {
  const record = vi.fn(async (actor, action, entityRef, detail) =>
    ok({ id: '01890000-0000-7000-8000-00000000ffff', actor, action, entityRef, detail: detail ?? {}, createdAt: NOW })
  );
  return { audit: { record, listByEntity: vi.fn() } as unknown as AuditService, record };
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `01890000-0000-7000-8000-${String(idCounter).padStart(12, '0')}`;
}

function makeService(options: { product?: Product | null; templates?: FakeTemplates } = {}) {
  const templates = options.templates ?? new FakeTemplates();
  const storage = new MemoryStorage();
  const { audit, record } = fakeAudit();
  const service = createReportTemplateService({
    reportTemplates: templates,
    products: fakeProducts(options.product === undefined ? fixtureProduct() : options.product),
    storage,
    audit,
    now: () => NOW,
    generateId: nextId,
  });
  return { service, templates, storage, record };
}

const HTML = '<!doctype html><html><body><h1>{{t.report_title}}</h1></body></html>';

describe('reportTemplateService.upload', () => {
  it('stores the HTML bytes and records a draft with the next version number', async () => {
    const { service, storage, record } = makeService();

    const first = await service.upload(superAdmin, {
      productId: PRODUCT_ID,
      html: HTML,
      capabilities: { web: true, pdf: true },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.version).toBe(1);
    expect(first.value.status).toBe('draft');
    expect(first.value.capabilities).toEqual({ web: true, pdf: true });
    expect(first.value.storageKey).toBe(templateStorageKey(PRODUCT_ID, first.value.id));
    expect(storage.has(first.value.storageKey)).toBe(true);

    const stored = await storage.download(first.value.storageKey);
    expect(new TextDecoder().decode(stored!.body)).toBe(HTML);

    const second = await service.upload(superAdmin, {
      productId: PRODUCT_ID,
      html: HTML,
      capabilities: { web: true, pdf: false },
    });
    expect(second.ok && second.value.version === 2).toBe(true);

    expect(record).toHaveBeenCalledWith(
      { kind: 'user', id: 'admin-1' },
      'report_template.uploaded',
      { type: 'report_template_version', id: first.value.id },
      expect.objectContaining({ productId: PRODUCT_ID, version: 1 })
    );
  });

  it('allows the product org’s assessment_admin and rejects other orgs', async () => {
    const { service } = makeService();
    const allowed = await service.upload(orgAdmin, {
      productId: PRODUCT_ID,
      html: HTML,
      capabilities: { web: true, pdf: false },
    });
    expect(allowed.ok).toBe(true);

    const denied = await service.upload(otherOrgAdmin, {
      productId: PRODUCT_ID,
      html: HTML,
      capabilities: { web: true, pdf: false },
    });
    expect(!denied.ok && denied.error.code === 'report_template/forbidden').toBe(true);
  });

  it('rejects invalid payloads with line-item issues', async () => {
    const { service } = makeService();
    const result = await service.upload(superAdmin, {
      productId: PRODUCT_ID,
      html: '',
      capabilities: { web: false, pdf: false },
    });
    expect(!result.ok && result.error.code === 'report_template/validation').toBe(true);
    if (result.ok) return;
    const issues = result.error.detail?.['issues'] as { path: string }[];
    expect(issues.some((i) => i.path === 'html')).toBe(true);
    expect(issues.some((i) => i.path === 'capabilities')).toBe(true);
  });

  it('returns product_not_found for unknown products', async () => {
    const { service } = makeService({ product: null });
    const result = await service.upload(superAdmin, {
      productId: PRODUCT_ID,
      html: HTML,
      capabilities: { web: true, pdf: false },
    });
    expect(!result.ok && result.error.code === 'report_template/product_not_found').toBe(true);
  });
});

describe('reportTemplateService.activate / retire', () => {
  async function uploadOne(service: ReturnType<typeof makeService>['service']) {
    const result = await service.upload(superAdmin, {
      productId: PRODUCT_ID,
      html: HTML,
      capabilities: { web: true, pdf: false },
    });
    if (!result.ok) throw new Error('upload failed');
    return result.value;
  }

  it('activates a draft and retires the incumbent (single active per product)', async () => {
    const { service, templates, record } = makeService();
    const v1 = await uploadOne(service);
    const v2 = await uploadOne(service);

    const first = await service.activate(superAdmin, v1.id);
    expect(first.ok && first.value.status === 'active').toBe(true);

    const second = await service.activate(superAdmin, v2.id);
    expect(second.ok && second.value.status === 'active').toBe(true);
    expect(templates.rows.get(v1.id)?.status).toBe('retired');
    expect(record).toHaveBeenCalledWith(
      { kind: 'user', id: 'admin-1' },
      'report_template.activated',
      { type: 'report_template_version', id: v2.id },
      expect.objectContaining({ supersededVersionId: v1.id })
    );
  });

  it('is idempotent for an already-active version and refuses retired ones', async () => {
    const { service } = makeService();
    const v1 = await uploadOne(service);
    await service.activate(superAdmin, v1.id);

    const again = await service.activate(superAdmin, v1.id);
    expect(again.ok && again.value.status === 'active').toBe(true);

    await service.retire(superAdmin, v1.id);
    const revive = await service.activate(superAdmin, v1.id);
    expect(!revive.ok && revive.error.code === 'report_template/invalid_state').toBe(true);
  });

  it('retire is idempotent and audited', async () => {
    const { service, record } = makeService();
    const v1 = await uploadOne(service);
    const retired = await service.retire(superAdmin, v1.id);
    expect(retired.ok && retired.value.status === 'retired').toBe(true);
    const again = await service.retire(superAdmin, v1.id);
    expect(again.ok).toBe(true);
    expect(record).toHaveBeenCalledWith(
      { kind: 'user', id: 'admin-1' },
      'report_template.retired',
      { type: 'report_template_version', id: v1.id },
      expect.objectContaining({ previousStatus: 'draft' })
    );
  });

  it('rejects non-managers', async () => {
    const { service } = makeService();
    const v1 = await uploadOne(service);
    const result = await service.activate(otherOrgAdmin, v1.id);
    expect(!result.ok && result.error.code === 'report_template/forbidden').toBe(true);
  });
});

describe('reportTemplateService.listByProduct', () => {
  it('lists versions newest first for managers', async () => {
    const { service } = makeService();
    await service.upload(superAdmin, { productId: PRODUCT_ID, html: HTML, capabilities: { web: true, pdf: false } });
    await service.upload(superAdmin, { productId: PRODUCT_ID, html: HTML, capabilities: { web: true, pdf: true } });

    const listed = await service.listByProduct(orgAdmin, PRODUCT_ID);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((v) => v.version)).toEqual([2, 1]);
  });

  it('rejects callers outside the product org', async () => {
    const { service } = makeService();
    const listed = await service.listByProduct(otherOrgAdmin, PRODUCT_ID);
    expect(!listed.ok && listed.error.code === 'report_template/forbidden').toBe(true);
  });
});
