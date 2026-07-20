export {
  createClientDirectoryService,
  type ClientDirectoryService,
  type ClientDirectoryServiceDeps,
} from './client-directory-service';
export { getClientDirectoryService } from './default';
// Entity type re-exported for controllers — apps never import repositories
// directly (.dependency-cruiser.cjs).
export type { ClientSummary } from '@assessify/repositories';
