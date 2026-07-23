export {
  createClientDirectoryService,
  type ClientDirectoryService,
  type ClientDirectoryServiceDeps,
} from './client-directory-service';
export {
  createClientService,
  type ClientService,
  type ClientServiceDeps,
} from './client-service';
export { getClientDirectoryService, getClientService } from './default';
// Entity type re-exported for controllers — apps never import repositories
// directly (.dependency-cruiser.cjs).
export type { ClientSummary } from '@assessify/repositories';
