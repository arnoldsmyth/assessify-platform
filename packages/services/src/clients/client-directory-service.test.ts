import { systemCallerContext, type CallerContext, type RoleAssignment } from '@assessify/domain';
import type { ClientRepository, ClientSummary } from '@assessify/repositories';
import { describe, expect, it } from 'vitest';

import { createClientDirectoryService } from './client-directory-service';

const CLIENT_A = '33333333-3333-7333-8333-333333333333';
const CLIENT_B = '44444444-4444-7444-8444-444444444444';
const ORG_A = '66666666-6666-7666-8666-666666666666';
const OTHER_ORG = '77777777-7777-7777-8777-777777777777';

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

function summary(id: string, name: string, organizationId: string = ORG_A): ClientSummary {
  return { id, organizationId, clientNumber: 1, name, defaultCurrency: 'EUR' };
}

function makeService(seed: ClientSummary[]) {
  const repo: ClientRepository = {
    async listAll() {
      return seed;
    },
    async findByIds(ids) {
      return seed.filter((client) => ids.includes(client.id));
    },
    async listByOrganizationIds(organizationIds) {
      return seed.filter((client) => organizationIds.includes(client.organizationId));
    },
  };
  return createClientDirectoryService({ clients: repo });
}

const seed = [summary(CLIENT_A, 'Acme'), summary(CLIENT_B, 'Globex')];

describe('clientDirectoryService.listPlaceable', () => {
  it('returns all clients for super_admin', async () => {
    const result = await makeService(seed).listPlaceable(superAdmin);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });

  it('returns only clients the caller may order for', async () => {
    const mixed: CallerContext = {
      kind: 'user',
      id: '22222222-2222-7222-8222-222222222222',
      roles: [
        assignment('client_admin', { clientId: CLIENT_A }),
        // Viewer-only client_user: visible but NOT placeable.
        assignment('client_user', {
          clientId: CLIENT_B,
          permissions: {
            products: 'all',
            groups: 'all',
            canPlaceOrders: false,
            canViewResults: true,
            canReleaseReports: false,
          },
        }),
      ],
    };
    const placeable = await makeService(seed).listPlaceable(mixed);
    expect(placeable.ok).toBe(true);
    if (placeable.ok) expect(placeable.value.map((c) => c.id)).toEqual([CLIENT_A]);

    const visible = await makeService(seed).listVisible(mixed);
    expect(visible.ok).toBe(true);
    if (visible.ok) expect(visible.value.map((c) => c.id).sort()).toEqual([CLIENT_A, CLIENT_B]);
  });

  it('returns an empty list for users with no ordering-capable roles', async () => {
    const nobody: CallerContext = {
      kind: 'user',
      id: '55555555-5555-7555-8555-555555555555',
      roles: [assignment('assessment_taker')],
    };
    const result = await makeService(seed).listPlaceable(nobody);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('denies non-user callers', async () => {
    const result = await makeService(seed).listPlaceable(systemCallerContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('client/forbidden');
  });
});

describe('clientDirectoryService org scoping (M2)', () => {
  const orgAdmin: CallerContext = {
    kind: 'user',
    id: '88888888-8888-7888-8888-888888888888',
    roles: [assignment('assessment_admin', { organizationId: ORG_A })],
  };

  it('org admins see all of their organization’s clients in listVisible', async () => {
    const mixedOrgs = [
      summary(CLIENT_A, 'Acme', ORG_A),
      summary(CLIENT_B, 'Globex', OTHER_ORG),
    ];
    const result = await makeService(mixedOrgs).listVisible(orgAdmin);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((c) => c.id)).toEqual([CLIENT_A]);
  });

  it('org admins get nothing from listPlaceable (read-only scope)', async () => {
    const result = await makeService(seed).listPlaceable(orgAdmin);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});
