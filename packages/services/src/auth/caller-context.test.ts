import { clientScopeIds, isSuperAdmin, orgScopeIds, type RoleAssignment } from '@assessify/domain';
import { describe, expect, it } from 'vitest';

import { createCallerContextService } from './caller-context';

function fakeRepo(rows: RoleAssignment[]) {
  return {
    listByUserId: async (_userId: string) => rows,
  };
}

const clientAdmin: RoleAssignment = {
  role: 'client_admin',
  organizationId: null,
  productId: null,
  clientId: '0197a7c0-0000-7000-8000-000000000001',
  permissions: {
    products: [],
    groups: [],
    canPlaceOrders: false,
    canViewResults: false,
    canReleaseReports: false,
  },
};

describe('createCallerContextService', () => {
  it('builds a user caller context with role assignments', async () => {
    const service = createCallerContextService({ roleAssignments: fakeRepo([clientAdmin]) });
    const result = await service.forUser('user_123');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('user');
    expect(result.value.id).toBe('user_123');
    expect(result.value.roles).toEqual([clientAdmin]);
    expect(clientScopeIds(result.value)).toEqual([clientAdmin.clientId]);
    expect(orgScopeIds(result.value)).toEqual([]);
    expect(isSuperAdmin(result.value)).toBe(false);
  });

  it('returns a context with no roles for a user without assignments', async () => {
    const service = createCallerContextService({ roleAssignments: fakeRepo([]) });
    const result = await service.forUser('user_no_roles');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roles).toEqual([]);
  });

  it('rejects an empty user id with an unauthenticated error', async () => {
    const service = createCallerContextService({ roleAssignments: fakeRepo([]) });
    const result = await service.forUser('   ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unauthenticated');
  });
});
