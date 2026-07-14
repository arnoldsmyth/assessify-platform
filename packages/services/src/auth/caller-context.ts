import {
  err,
  ok,
  unauthenticatedError,
  type CallerContext,
  type Result,
} from '@assessify/domain';
import {
  createRoleAssignmentRepository,
  type RoleAssignmentRepository,
} from '@assessify/repositories';

/**
 * Builds the CallerContext every service method authorizes against (spec 05).
 * Controllers authenticate (Better Auth session, API key, respondent token)
 * and hand only an identity to this service — cookies/sessions never cross
 * the layer boundary.
 */
export interface CallerContextService {
  /** Caller context for a session-authenticated Better Auth user. */
  forUser(userId: string): Promise<Result<CallerContext>>;
}

export function createCallerContextService(deps: {
  roleAssignments: RoleAssignmentRepository;
}): CallerContextService {
  return {
    async forUser(userId: string): Promise<Result<CallerContext>> {
      const id = userId.trim();
      if (id === '') {
        return err(unauthenticatedError('A user id is required to build a caller context.'));
      }
      const roles = await deps.roleAssignments.listByUserId(id);
      return ok({ kind: 'user', id, roles });
    },
  };
}

/**
 * Composition helper for controllers: the layer rules forbid apps from
 * importing repositories, so the service layer wires its own data access
 * from a connection string. Reuses one pooled connection per process.
 */
export function createCallerContextServiceFromDatabaseUrl(
  databaseUrl: string
): CallerContextService {
  return createCallerContextService({
    roleAssignments: createRoleAssignmentRepository(databaseUrl),
  });
}
