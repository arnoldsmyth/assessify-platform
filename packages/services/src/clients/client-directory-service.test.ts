import { systemCallerContext, type CallerContext, type RoleAssignment } from '@assessify/domain';
import type { ClientRepository, ClientSummary } from '@assessify/repositories';
import { describe, expect, it } from 'vitest';

import { createClientDirectoryService } from './client-directory-service';

const CLIENT_A = '33333333-3333-7333-8333-333333333333';
const CLIENT_B = '44444444-4444-7444-8444-444444444444';

function assignment(
  role: RoleAssignment['role'],
  overrides: Partial<RoleAssignment> = {}
): RoleAssignment {
  return {
    role,
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

function summary(id: string, name: string): ClientSummary {
  return { id, clientNumber: 1, name, defaultCurrency: 'EUR', isPlatformRetail: false };
}

function makeService(seed: ClientSummary[]) {
  const repo: ClientRepository = {
    async listAll() {
      return seed;
    },
    async findByIds(ids) {
      return seed.filter((client) => ids.includes(client.id));
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
