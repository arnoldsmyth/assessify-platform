import { getReminderService, type ReminderService } from '@assessify/services';

import { getServerEnv } from './env';
import { getJobQueue } from './queue';

/**
 * Web-side reminder service composition (D6). Used by the admin order detail
 * actions: manual "remind now" and per-session suppress/resume. The queue is
 * needed because a manual send goes through the notification service, which
 * enqueues the actual delivery (`notifications.send`) — no emails leave a
 * request handler (spec 13). Config mirrors invitations: links on the
 * primary slug base domain, the platform sender backing products without
 * branding.emailFrom.
 */
export function getWebReminderService(): ReminderService {
  const env = getServerEnv();
  const queue = getJobQueue();
  return getReminderService(
    { ...(queue !== null && { queue }) },
    {
      slugBaseDomain: env.PRODUCT_SLUG_BASE_DOMAINS[0] ?? 'assessify.ie',
      platformSender: { name: env.MAIL_FROM_NAME, address: env.MAIL_FROM_ADDRESS },
    }
  );
}
