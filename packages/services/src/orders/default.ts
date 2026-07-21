import {
  createAuditLogRepository,
  createClientProductAccessRepository,
  createClientRepository,
  createOrderRepository,
  createProductPriceRepository,
  DrizzleProductRepository,
  getDbHandle,
} from '@assessify/repositories';

import { createAuditService } from '../audit';
import { createOrderService, type OrderService } from './order-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

let instance: OrderService | undefined;

/**
 * Default composition-root wiring: Drizzle repositories over DATABASE_URL,
 * sharing the process-wide pg pool via getDbHandle. Lives in the service
 * layer because apps must not import repositories or db
 * (.dependency-cruiser.cjs). Lazy so importing @assessify/services never
 * opens a connection at module load (or during `next build`).
 */
export function getOrderService(): OrderService {
  if (!instance) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set — required for the default order service wiring');
    }
    const { db } = getDbHandle(connectionString);
    instance = createOrderService({
      orders: createOrderRepository(db),
      products: new DrizzleProductRepository(db),
      clients: createClientRepository(db),
      clientProductAccess: createClientProductAccessRepository(db),
      productPrices: createProductPriceRepository(db),
      audit: createAuditService({ auditLogRepository: createAuditLogRepository(db) }),
    });
  }
  return instance;
}
