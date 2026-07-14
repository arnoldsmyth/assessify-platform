import { roleAssignments } from '@assessify/db';
import { roleAssignmentSchema, type RoleAssignment } from '@assessify/domain';
import { eq } from 'drizzle-orm';

import { getDbHandle } from './client';

/** Read access to `role_assignments` (spec 05). */
export interface RoleAssignmentRepository {
  /** All role assignments held by a Better Auth user (may be empty). */
  listByUserId(userId: string): Promise<RoleAssignment[]>;
}

export function createRoleAssignmentRepository(connectionString: string): RoleAssignmentRepository {
  const { db } = getDbHandle(connectionString);
  return {
    async listByUserId(userId: string): Promise<RoleAssignment[]> {
      const rows = await db
        .select({
          role: roleAssignments.role,
          productId: roleAssignments.productId,
          clientId: roleAssignments.clientId,
          permissions: roleAssignments.permissions,
        })
        .from(roleAssignments)
        .where(eq(roleAssignments.userId, userId));

      // Zod-validate at the boundary: rows map to domain entities, never raw.
      return rows.map((row) =>
        roleAssignmentSchema.parse({
          role: row.role,
          productId: row.productId,
          clientId: row.clientId,
          permissions: row.permissions ?? {},
        })
      );
    },
  };
}
