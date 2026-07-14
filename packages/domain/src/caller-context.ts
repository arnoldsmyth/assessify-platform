import { z } from 'zod';

/**
 * Caller identity and authorization scopes (docs/spec/05-roles-and-access.md).
 *
 * Every service method takes a CallerContext and checks scope before acting.
 * Controllers only authenticate and construct the context — services never
 * see cookies, sessions, or HTTP. A user can hold multiple role assignments
 * (e.g. client_admin of two clients).
 */

/** Staff/client roles, session-authenticated via Better Auth (spec 05). */
export const roleNames = [
  'super_admin',
  'assessment_admin',
  'client_admin',
  'client_user',
  'assessment_taker',
] as const;

export const roleNameSchema = z.enum(roleNames);
export type RoleName = z.infer<typeof roleNameSchema>;

export const callerKinds = ['user', 'api_key', 'respondent', 'system'] as const;

export const callerKindSchema = z.enum(callerKinds);
export type CallerKind = z.infer<typeof callerKindSchema>;

/**
 * `role_assignments.permissions` jsonb for `client_user` (spec 05).
 * Defaults deny everything — an empty `{}` grants nothing.
 */
export const clientUserPermissionsSchema = z.object({
  products: z.union([z.literal('all'), z.array(z.string().uuid())]).default([]),
  groups: z.union([z.literal('all'), z.array(z.string().uuid())]).default([]),
  canPlaceOrders: z.boolean().default(false),
  canViewResults: z.boolean().default(false),
  canReleaseReports: z.boolean().default(false),
});
export type ClientUserPermissions = z.infer<typeof clientUserPermissionsSchema>;

/** One row of `role_assignments`, mapped to the domain. */
export const roleAssignmentSchema = z.object({
  role: roleNameSchema,
  /** Product scope — required for assessment_admin, null otherwise. */
  productId: z.string().uuid().nullable().default(null),
  /** Client scope — required for client_admin / client_user, null otherwise. */
  clientId: z.string().uuid().nullable().default(null),
  /** client_user restrictions; ignored for other roles. */
  permissions: clientUserPermissionsSchema.default({}),
});
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

export const callerContextSchema = z.object({
  kind: callerKindSchema,
  /** Better Auth user id, API key id, respondent session id, or 'system'. */
  id: z.string().min(1),
  roles: z.array(roleAssignmentSchema),
});
export type CallerContext = z.infer<typeof callerContextSchema>;

/** Context for internal/background work (workers, migrations) — bypasses nothing by itself; services decide what 'system' may do. */
export function systemCallerContext(): CallerContext {
  return { kind: 'system', id: 'system', roles: [] };
}

export function hasRole(context: CallerContext, role: RoleName): boolean {
  return context.roles.some((assignment) => assignment.role === role);
}

export function isSuperAdmin(context: CallerContext): boolean {
  return context.kind === 'user' && hasRole(context, 'super_admin');
}

/** Client ids the caller is scoped to via client_admin / client_user rows. */
export function clientScopeIds(context: CallerContext): string[] {
  const ids = context.roles
    .filter((a) => (a.role === 'client_admin' || a.role === 'client_user') && a.clientId !== null)
    .map((a) => a.clientId as string);
  return [...new Set(ids)];
}

/** Product ids the caller is scoped to via assessment_admin rows. */
export function productScopeIds(context: CallerContext): string[] {
  const ids = context.roles
    .filter((a) => a.role === 'assessment_admin' && a.productId !== null)
    .map((a) => a.productId as string);
  return [...new Set(ids)];
}
