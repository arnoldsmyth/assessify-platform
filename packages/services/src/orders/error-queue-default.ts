import {
  createAuditLogRepository,
  createClientRepository,
  createNotificationLogRepository,
  createOrderRepository,
  DrizzleProductRepository,
  getDbHandle,
} from '@assessify/repositories';

import { createAuditService } from '../audit';
import { createErrorQueueService, type ErrorQueueService } from './error-queue-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

let instance: ErrorQueueService | undefined;

/**
 * Default composition-root wiring: Drizzle repositories over DATABASE_URL,
 * sharing the process-wide pg pool via getDbHandle. Lives in the service
 * layer because apps must not import repositories or db
 * (.dependency-cruiser.cjs). Lazy so importing @assessify/services never
 * opens a connection at module load (or during `next build`).
 */
export function getErrorQueueService(): ErrorQueueService {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set — required for the default error queue service wiring'
      );
    }
    const { db } = getDbHandle(connectionString);
    instance = createErrorQueueService({
      orders: createOrderRepository(db),
      notificationLog: createNotificationLogRepository(db),
      clients: createClientRepository(db),
      products: new DrizzleProductRepository(db),
      audit: createAuditService({ auditLogRepository: createAuditLogRepository(db) }),
    });
  }
  return instance;
}
