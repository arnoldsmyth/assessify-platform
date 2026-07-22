import {
  createAuditLogRepository,
  createClientNotificationRepository,
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
import {
  createCompletionNotificationService,
  type CompletionNotificationConfig,
  type CompletionNotificationService,
} from './completion-notification-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

/**
 * Adapter instances the composition root supplies. The queue is required for
 * actual sends (the notification service enqueues `notifications.send` —
 * spec 13: no emails from request handlers); without it every send fails
 * into the summary, and releases still succeed (the hook is never fatal).
 */
export interface CompletionNotificationServiceAdapters {
  queue?: JobQueue;
}

/**
 * Default composition-root wiring: Drizzle repositories over DATABASE_URL
 * (shared pg pool via getDbHandle). Config (link base domain, platform
 * sender) comes from the caller's validated env — the service layer knows
 * nothing about env-var naming. Call lazily — never at module load.
 */
export function getCompletionNotificationService(
  adapters: CompletionNotificationServiceAdapters,
  config: CompletionNotificationConfig
): CompletionNotificationService {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set — required for the default completion notification wiring'
    );
  }
  const { db } = getDbHandle(connectionString);
  return createCompletionNotificationService({
    orders: createOrderRepository(db),
    products: new DrizzleProductRepository(db),
    clients: createClientNotificationRepository(db),
    sessions: createInvitationSessionRepository(db),
    customDomains: createCustomDomainRepository(db),
    notificationLog: createNotificationLogRepository(db),
    notifications: createNotificationService({
      notificationLog: createNotificationLogRepository(db),
      ...(adapters.queue !== undefined && { queue: adapters.queue }),
    }),
    audit: createAuditService({ auditLogRepository: createAuditLogRepository(db) }),
    config,
  });
}
