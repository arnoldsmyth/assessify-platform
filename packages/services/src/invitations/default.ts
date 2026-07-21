import {
  createAuditLogRepository,
  createCustomDomainRepository,
  createInvitationSessionRepository,
  createNotificationLogRepository,
  createOrderRepository,
  DrizzleProductRepository,
  getDbHandle,
} from '@assessify/repositories';
import type { JobQueue } from '@assessify/adapters';

import { createAuditService } from '../audit';
import { createNotificationService } from '../notifications';
import { getOrderService } from '../orders';
import { createBcryptPinHasher } from '../respondent-access';
import {
  createInvitationService,
  type InvitationConfig,
  type InvitationService,
} from './invitation-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

/**
 * Adapter instances the composition root supplies. The queue is required for
 * the request paths (enqueue `invitations.dispatch`) AND for the worker path
 * (the notification service enqueues `notifications.send`); the bounce-only
 * webhook path can omit it — alerts are then skipped, transitions still land.
 */
export interface InvitationServiceAdapters {
  queue?: JobQueue;
}

/**
 * Default composition-root wiring: Drizzle repositories over DATABASE_URL
 * (shared pg pool via getDbHandle), bcrypt PIN hashing (the SAME port C1
 * verification uses), and the order state machine via `getOrderService`.
 * Config (link base domain, platform sender, alert recipients) comes from
 * the caller's validated env — the service layer knows nothing about env-var
 * naming. Not memoised: adapters/config legitimately differ per call site
 * (worker vs webhook); the pg pool underneath IS shared.
 */
export function getInvitationService(
  adapters: InvitationServiceAdapters,
  config: InvitationConfig
): InvitationService {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set — required for the default invitation service wiring'
    );
  }
  const { db } = getDbHandle(connectionString);
  return createInvitationService({
    sessions: createInvitationSessionRepository(db),
    orders: createOrderRepository(db),
    orderService: getOrderService(),
    products: new DrizzleProductRepository(db),
    customDomains: createCustomDomainRepository(db),
    notifications: createNotificationService({
      notificationLog: createNotificationLogRepository(db),
      ...(adapters.queue !== undefined && { queue: adapters.queue }),
    }),
    pinHasher: createBcryptPinHasher(),
    audit: createAuditService({ auditLogRepository: createAuditLogRepository(db) }),
    ...(adapters.queue !== undefined && { queue: adapters.queue }),
    config,
  });
}
