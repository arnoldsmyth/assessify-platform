import { ok, type CallerContext, type Product, type RoleAssignment } from '@assessify/domain';
import type { QuestionnaireDefinitionInput } from '@assessify/questionnaire-schema';
import type {
  ProductRepository,
  QuestionnaireVersion,
  QuestionnaireVersionRepository,
} from '@assessify/repositories';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit';
import { createQuestionnaireVersionService } from './questionnaire-version-service';

const PRODUCT_ID = '01890000-0000-7000-8000-000000000001';
const OTHER_PRODUCT_ID = '01890000-0000-7000-8000-000000000002';
const ORG_ID = '01890000-0000-7000-8000-0000000000a1';
const OTHER_ORG_ID = '01890000-0000-7000-8000-0000000000a2';

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

const superAdmin: CallerContext = {
  kind: 'user',
  id: '11111111-1111-7111-8111-111111111111',
  roles: [assignment('super_admin')],
};
// assessment_admin is org-scoped (M2): "may manage this product" resolves
// through the product's organization.
const productAdmin: CallerContext = {
  kind: 'user',
  id: '22222222-2222-7222-8222-222222222222',
  roles: [assignment('assessment_admin', { organizationId: ORG_ID })],
};
const otherProductAdmin: CallerContext = {
  kind: 'user',
  id: '44444444-4444-7444-8444-444444444444',
  roles: [assignment('assessment_admin', { organizationId: OTHER_ORG_ID })],
};
const clientAdmin: CallerContext = {
  kind: 'user',
  id: '33333333-3333-7333-8333-333333333333',
  roles: [assignment('client_admin', { clientId: '55555555-5555-7555-8555-555555555555' })],
};
// Better Auth user ids are NOT uuid-shaped (asy-3d4) — e.g.
// 'LpsL6cXdIE1zgvLQoEL1aA5agzsd7bOq'. `questionnaire_versions.created_by`
// must accept this shape without hitting Postgres 22P02.
const betterAuthAdmin: CallerContext = {
  kind: 'user',
  id: 'LpsL6cXdIE1zgvLQoEL1aA5agzsd7bOq',
  roles: [assignment('super_admin')],
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
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Minimal valid definition per spec 07 / @assessify/questionnaire-schema. */
function validDefinition(key = 'pro-d-core'): QuestionnaireDefinitionInput {
  return {
    schemaVersion: 1,
    key,
    titleKey: 'q.title',
    settings: { progressBar: true, allowBack: true },
    sections: [
      {
        key: 'sec-1',
        titleKey: 'sec1.title',
        questions: [
          {
            key: 'q1',
            textKey: 'q1.text',
            type: 'likert',
            scale: { min: 1, max: 5, labelKeys: { '1': 'q1.low', '5': 'q1.high' }, presentation: 'radio' },
          },
        ],
      },
    ],
  };
}

function fixtureVersion(overrides: Partial<QuestionnaireVersion> = {}): QuestionnaireVersion {
  return {
    id: '018a0000-0000-7000-8000-000000000001',
    productId: PRODUCT_ID,
    version: 1,
    variant: 'self',
    // Fixtures store the validated (defaults-applied) form.
    definition: {
      ...validDefinition(),
      sections: [
        {
          key: 'sec-1',
          titleKey: 'sec1.title',
          questions: [
            {
              key: 'q1',
              textKey: 'q1.text',
              required: true,
              type: 'likert',
              scale: {
                min: 1,
                max: 5,
                labelKeys: { '1': 'q1.low', '5': 'q1.high' },
                presentation: 'radio',
              },
            },
          ],
        },
      ],
    },
    status: 'draft',
    createdBy: superAdmin.id,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

/** In-memory fake implementing the questionnaire version repository port. */
function makeVersionRepo(seed: QuestionnaireVersion[] = []) {
  const rows = new Map<string, QuestionnaireVersion>(seed.map((v) => [v.id, v]));
  const repo: QuestionnaireVersionRepository = {
    async findById(id) {
      return rows.get(id) ?? null;
    },
    async findActive(productId, variant) {
      return (
        [...rows.values()].find(
          (v) => v.productId === productId && v.variant === variant && v.status === 'active'
        ) ?? null
      );
    },
    async listByProduct(productId) {
      return [...rows.values()]
        .filter((v) => v.productId === productId)
        .sort((a, b) => b.version - a.version || a.variant.localeCompare(b.variant));
    },
    async maxVersion(productId) {
      return [...rows.values()]
        .filter((v) => v.productId === productId)
        .reduce((max, v) => Math.max(max, v.version), 0);
    },
    async insert(version) {
      rows.set(version.id, version);
      return version;
    },
    async updateStatus(id, status) {
      const existing = rows.get(id);
      if (!existing) return null;
      const updated = { ...existing, status };
      rows.set(id, updated);
      return updated;
    },
  };
  return { repo, rows };
}

function makeProductRepo(seed: Product[] = [fixtureProduct()]): ProductRepository {
  const rows = new Map(seed.map((p) => [p.id, p]));
  return {
    async findById(id: string) {
      return rows.get(id) ?? null;
    },
    findBySlug: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    list: vi.fn(),
  } as unknown as ProductRepository;
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

function makeService(seed: QuestionnaireVersion[] = [], products: Product[] = [fixtureProduct()]) {
  const { repo, rows } = makeVersionRepo(seed);
  const audit = makeAudit();
  const service = createQuestionnaireVersionService({
    questionnaireVersions: repo,
    products: makeProductRepo(products),
    audit,
    now: () => new Date('2026-07-14T12:00:00Z'),
  });
  return { service, rows, audit };
}

describe('questionnaireVersionService.importDefinition', () => {
  it('imports a valid definition as draft version 1 (happy path)', async () => {
    const { service, rows, audit } = makeService();

    const result = await service.importDefinition(superAdmin, {
      productId: PRODUCT_ID,
      definition: validDefinition(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const version = result.value;
    expect(version.version).toBe(1);
    expect(version.variant).toBe('self');
    expect(version.status).toBe('draft');
    expect(version.productId).toBe(PRODUCT_ID);
    expect(version.createdBy).toBe(superAdmin.id);
    expect(version.createdAt).toEqual(new Date('2026-07-14T12:00:00Z'));
    // Validator defaults were applied (required: true on the question).
    expect(version.definition.sections[0]?.questions[0]?.required).toBe(true);
    expect(rows.get(version.id)).toEqual(version);
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: superAdmin.id },
      'questionnaire_version.imported',
      { type: 'questionnaire_version', id: version.id },
      { productId: PRODUCT_ID, version: 1, variant: 'self', definitionKey: 'pro-d-core' }
    );
  });

  it('assigns the next version number per product across variants', async () => {
    const seed = [
      fixtureVersion({ id: '018a0000-0000-7000-8000-000000000001', version: 1, status: 'retired' }),
      fixtureVersion({
        id: '018a0000-0000-7000-8000-000000000002',
        version: 2,
        variant: 'manager',
        status: 'active',
      }),
    ];
    const { service } = makeService(seed);

    const result = await service.importDefinition(superAdmin, {
      productId: PRODUCT_ID,
      definition: validDefinition('pro-d-v3'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.version).toBe(3);
  });

  it('rejects an invalid definition with structured line-item issues', async () => {
    const { service, rows } = makeService();
    const bad = validDefinition() as Record<string, unknown>;
    bad.sections = [
      {
        key: 'sec-1',
        questions: [
          {
            key: 'q1',
            textKey: 'q1.text',
            type: 'ranking',
            // Semantic rule: ranking needs >= 2 options (and <= 10).
            options: [{ key: 'a', labelKey: 'a.label' }],
          },
        ],
      },
    ];

    const result = await service.importDefinition(superAdmin, {
      productId: PRODUCT_ID,
      definition: bad,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('questionnaire_definition_invalid');
      const issues = result.error.detail?.issues as { path: string; message: string }[];
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]?.path).toContain('sections[0]');
      expect(issues[0]?.message).toBeTruthy();
    }
    expect(rows.size).toBe(0);
  });

  it('rejects a malformed envelope (bad productId / variant) before touching the definition', async () => {
    const { service } = makeService();

    const badProduct = await service.importDefinition(superAdmin, {
      productId: 'not-a-uuid',
      definition: validDefinition(),
    });
    expect(badProduct.ok).toBe(false);
    if (!badProduct.ok) expect(badProduct.error.code).toBe('questionnaire_version/validation');

    const badVariant = await service.importDefinition(superAdmin, {
      productId: PRODUCT_ID,
      variant: 'Not Valid!',
      definition: validDefinition(),
    });
    expect(badVariant.ok).toBe(false);
    if (!badVariant.ok) expect(badVariant.error.code).toBe('questionnaire_version/validation');
  });

  it('returns product_not_found for an unknown product', async () => {
    const { service } = makeService([], []);

    const result = await service.importDefinition(superAdmin, {
      productId: PRODUCT_ID,
      definition: validDefinition(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('questionnaire_version/product_not_found');
  });

  it('records a text (Better Auth-shaped, non-uuid) caller id as created_by (asy-3d4)', async () => {
    const { service, rows } = makeService();

    const result = await service.importDefinition(betterAuthAdmin, {
      productId: PRODUCT_ID,
      definition: validDefinition(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.createdBy).toBe(betterAuthAdmin.id);
    expect(rows.get(result.value.id)?.createdBy).toBe(betterAuthAdmin.id);
  });

  it('allows the product’s assessment_admin and denies others', async () => {
    const { service } = makeService();

    const allowed = await service.importDefinition(productAdmin, {
      productId: PRODUCT_ID,
      definition: validDefinition(),
    });
    expect(allowed.ok).toBe(true);

    for (const caller of [otherProductAdmin, clientAdmin]) {
      const denied = await service.importDefinition(caller, {
        productId: PRODUCT_ID,
        definition: validDefinition(),
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('questionnaire_version/forbidden');
    }
  });
});

describe('questionnaireVersionService.activate', () => {
  it('activates a draft and retires the previously active version (swap)', async () => {
    const active = fixtureVersion({
      id: '018a0000-0000-7000-8000-000000000001',
      version: 1,
      status: 'active',
    });
    const draft = fixtureVersion({
      id: '018a0000-0000-7000-8000-000000000002',
      version: 2,
      status: 'draft',
    });
    const { service, rows, audit } = makeService([active, draft]);

    const result = await service.activate(superAdmin, draft.id);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('active');
    expect(rows.get(active.id)?.status).toBe('retired');
    expect(rows.get(draft.id)?.status).toBe('active');
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: superAdmin.id },
      'questionnaire_version.activated',
      { type: 'questionnaire_version', id: draft.id },
      { productId: PRODUCT_ID, version: 2, variant: 'self', supersededVersionId: active.id }
    );
  });

  it('only retires the incumbent of the same variant', async () => {
    const selfActive = fixtureVersion({
      id: '018a0000-0000-7000-8000-000000000001',
      version: 1,
      variant: 'self',
      status: 'active',
    });
    const managerDraft = fixtureVersion({
      id: '018a0000-0000-7000-8000-000000000002',
      version: 1,
      variant: 'manager',
      status: 'draft',
    });
    const { service, rows } = makeService([selfActive, managerDraft]);

    const result = await service.activate(superAdmin, managerDraft.id);

    expect(result.ok).toBe(true);
    expect(rows.get(selfActive.id)?.status).toBe('active');
    expect(rows.get(managerDraft.id)?.status).toBe('active');
  });

  it('is idempotent for an already-active version', async () => {
    const active = fixtureVersion({ status: 'active' });
    const { service, audit } = makeService([active]);

    const result = await service.activate(superAdmin, active.id);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('active');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses to reactivate a retired version', async () => {
    const retired = fixtureVersion({ status: 'retired' });
    const { service } = makeService([retired]);

    const result = await service.activate(superAdmin, retired.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('questionnaire_version/invalid_state');
  });

  it('returns not_found for unknown or malformed ids', async () => {
    const { service } = makeService();

    const unknown = await service.activate(superAdmin, '018a0000-0000-7000-8000-00000000ffff');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('questionnaire_version/not_found');

    const malformed = await service.activate(superAdmin, 'nope');
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe('questionnaire_version/not_found');
  });

  it('denies callers without product scope', async () => {
    const draft = fixtureVersion();
    const { service, rows } = makeService([draft]);

    for (const caller of [otherProductAdmin, clientAdmin]) {
      const result = await service.activate(caller, draft.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('questionnaire_version/forbidden');
    }
    expect(rows.get(draft.id)?.status).toBe('draft');
  });
});

describe('questionnaireVersionService.retire', () => {
  it('retires an active version and is idempotent', async () => {
    const active = fixtureVersion({ status: 'active' });
    const { service, audit } = makeService([active]);

    const retired = await service.retire(superAdmin, active.id);
    expect(retired.ok).toBe(true);
    if (retired.ok) expect(retired.value.status).toBe('retired');
    expect(audit.record).toHaveBeenCalledWith(
      { kind: 'user', id: superAdmin.id },
      'questionnaire_version.retired',
      { type: 'questionnaire_version', id: active.id },
      { productId: PRODUCT_ID, version: 1, variant: 'self', previousStatus: 'active' }
    );

    const again = await service.retire(superAdmin, active.id);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.status).toBe('retired');
  });
});

describe('questionnaireVersionService.listByProduct', () => {
  it('lists versions newest first for authorized callers', async () => {
    const v1 = fixtureVersion({
      id: '018a0000-0000-7000-8000-000000000001',
      version: 1,
      status: 'retired',
    });
    const v2 = fixtureVersion({
      id: '018a0000-0000-7000-8000-000000000002',
      version: 2,
      status: 'active',
    });
    const { service } = makeService([v1, v2]);

    for (const caller of [superAdmin, productAdmin]) {
      const result = await service.listByProduct(caller, PRODUCT_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.map((v) => v.version)).toEqual([2, 1]);
      }
    }
  });

  it('denies unauthorized callers and rejects unknown products', async () => {
    const { service } = makeService();

    const denied = await service.listByProduct(clientAdmin, PRODUCT_ID);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('questionnaire_version/forbidden');

    const missing = await service.listByProduct(superAdmin, OTHER_PRODUCT_ID);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('questionnaire_version/product_not_found');
  });
});

describe('questionnaireVersionService.listActiveForOrdering', () => {
  it('returns only active versions as a slim projection, to order placers too', async () => {
    const retired = fixtureVersion({
      id: '018a0000-0000-7000-8000-000000000001',
      version: 1,
      status: 'retired',
    });
    const activeSelf = fixtureVersion({
      id: '018a0000-0000-7000-8000-000000000002',
      version: 2,
      status: 'active',
    });
    const draft = fixtureVersion({
      id: '018a0000-0000-7000-8000-000000000003',
      version: 3,
      status: 'draft',
    });
    const { service } = makeService([retired, activeSelf, draft]);

    // clientAdmin cannot manage versions but CAN place orders (spec 05).
    for (const caller of [superAdmin, productAdmin, clientAdmin]) {
      const result = await service.listActiveForOrdering(caller, PRODUCT_ID);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([{ id: activeSelf.id, version: 2, variant: 'self' }]);
      }
    }
  });

  it('denies callers who can neither manage the product nor place orders', async () => {
    const { service } = makeService([fixtureVersion({ status: 'active' })]);
    const denied = await service.listActiveForOrdering(otherProductAdmin, PRODUCT_ID);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('questionnaire_version/forbidden');

    const missing = await service.listActiveForOrdering(superAdmin, OTHER_PRODUCT_ID);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('questionnaire_version/product_not_found');
  });
});
