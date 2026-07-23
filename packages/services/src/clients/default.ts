import {
  createAuditLogRepository,
  createClientRepository,
  createOrganizationRepository,
  getDbHandle,
} from '@assessify/repositories';

import { createAuditService } from '../audit';
import {
  createClientDirectoryService,
  type ClientDirectoryService,
} from './client-directory-service';
import { createClientService, type ClientService } from './client-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

let directoryInstance: ClientDirectoryService | undefined;
let managementInstance: ClientService | undefined;

function requireConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — required for the default client service wiring');
  }
  return connectionString;
}

/**
 * Default composition-root wiring: Drizzle repositories over DATABASE_URL,
 * sharing the process-wide pg pool via getDbHandle. Lives in the service
 * layer because apps must not import repositories or db
 * (.dependency-cruiser.cjs). Lazy so importing @assessify/services never
 * opens a connection at module load (or during `next build`).
 */
export function getClientDirectoryService(): ClientDirectoryService {
  if (!directoryInstance) {
    const { db } = getDbHandle(requireConnectionString());
    directoryInstance = createClientDirectoryService({ clients: createClientRepository(db) });
  }
  return directoryInstance;
}

/** Default composition-root wiring for the client management (write) service — see {@link getClientDirectoryService}. */
export function getClientService(): ClientService {
  if (!managementInstance) {
    const { db } = getDbHandle(requireConnectionString());
    managementInstance = createClientService({
      clients: createClientRepository(db),
      organizations: createOrganizationRepository(db),
      audit: createAuditService({ auditLogRepository: createAuditLogRepository(db) }),
    });
  }
  return managementInstance;
}
