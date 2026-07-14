// Postgres (Drizzle) repositories. Firestore repositories land with A4.
export { getDbHandle } from './postgres/client';
export {
  createRoleAssignmentRepository,
  type RoleAssignmentRepository,
} from './postgres/role-assignments';
