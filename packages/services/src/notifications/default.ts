import { createNotificationLogRepository, getDbHandle } from '@assessify/repositories';
import type { JobQueue, Mailer } from '@assessify/adapters';

import {
  createNotificationService,
  type NotificationService,
} from './notification-service';

// Module compiles with lib ES2022 (no @types/node in this package); declare
// the bits of `process` the default wiring needs.
declare const process: { env: Record<string, string | undefined> };

/**
 * Adapter instances the composition root supplies. Concrete providers
 * (SendGrid, BullMQ) are constructed by the app — services never import
 * providers (.dependency-cruiser.cjs). Paths that only read/update the log
 * (the SendGrid event webhook) can omit both.
 */
export interface NotificationServiceAdapters {
  mailer?: Mailer;
  queue?: JobQueue;
}

/**
 * Default composition-root wiring: Drizzle notification-log repository over
 * DATABASE_URL, sharing the process-wide pg pool via getDbHandle. Lives in
 * the service layer because apps must not import repositories or db
 * (.dependency-cruiser.cjs). Call lazily — never at module load.
 */
export function getNotificationService(
  adapters: NotificationServiceAdapters = {}
): NotificationService {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set — required for the default notification service wiring'
    );
  }
  const { db } = getDbHandle(connectionString);
  return createNotificationService({
    notificationLog: createNotificationLogRepository(db),
    ...adapters,
  });
}
