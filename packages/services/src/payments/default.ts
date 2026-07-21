import {
  createAuditLogRepository,
  createOrderRepository,
  createPaymentRepository,
  DrizzleProductRepository,
  getDbHandle,
} from '@assessify/repositories';

import { createAuditService } from '../audit';
import { createOrderService } from '../orders';
import {
  createPaymentService,
  type PaymentService,
  type PaymentServiceAdapters,
} from './payment-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

/**
 * Default composition-root wiring: Drizzle repositories over DATABASE_URL,
 * sharing the process-wide pg pool via getDbHandle. Lives in the service
 * layer because apps must not import repositories or db
 * (.dependency-cruiser.cjs). Call lazily — never at module load.
 *
 * Concrete payment providers (Stripe REST, offline) are constructed by the
 * app and passed in — services never import providers. The Stripe webhook
 * route passes none: handleEvent only reads/writes the payments store and
 * drives the order service.
 */
export function getPaymentService(adapters: PaymentServiceAdapters = {}): PaymentService {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — required for the default payment service wiring');
  }
  const { db } = getDbHandle(connectionString);
  const orders = createOrderRepository(db);
  const audit = createAuditService({ auditLogRepository: createAuditLogRepository(db) });
  return createPaymentService({
    payments: createPaymentRepository(db),
    orders,
    orderService: createOrderService({
      orders,
      products: new DrizzleProductRepository(db),
      audit,
    }),
    audit,
    adapters,
  });
}
