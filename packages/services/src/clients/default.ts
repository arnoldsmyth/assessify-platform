import { createClientRepository, getDbHandle } from '@assessify/repositories';

import {
  createClientDirectoryService,
  type ClientDirectoryService,
} from './client-directory-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

let instance: ClientDirectoryService | undefined;

/**
 * Default composition-root wiring: Drizzle repositories over DATABASE_URL,
 * sharing the process-wide pg pool via getDbHandle. Lives in the service
 * layer because apps must not import repositories or db
 * (.dependency-cruiser.cjs). Lazy so importing @assessify/services never
 * opens a connection at module load (or during `next build`).
 */
export function getClientDirectoryService(): ClientDirectoryService {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set — required for the default client directory service wiring'
      );
    }
    const { db } = getDbHandle(connectionString);
    instance = createClientDirectoryService({ clients: createClientRepository(db) });
  }
  return instance;
}
