import { getInvitationService, type InvitationService } from '@assessify/services';

import { getServerEnv } from './env';
import { getJobQueue } from './queue';

/**
 * Web-side invitation service composition (D5). Used by the admin order
 * actions (enqueue dispatch/resend) and the SendGrid webhook (invitation
 * hard bounce → order email_error). Config comes from the validated env:
 * links are built on the primary slug base domain; the platform sender backs
 * products without branding.emailFrom and signs error alerts.
 */
export function getWebInvitationService(): InvitationService {
  const env = getServerEnv();
  const queue = getJobQueue();
  return getInvitationService(
    { ...(queue !== null && { queue }) },
    {
      slugBaseDomain: env.PRODUCT_SLUG_BASE_DOMAINS[0] ?? 'assessify.ie',
      platformSender: { name: env.MAIL_FROM_NAME, address: env.MAIL_FROM_ADDRESS },
      ...(env.ERROR_ALERT_EMAILS !== undefined && { alertRecipients: env.ERROR_ALERT_EMAILS }),
    }
  );
}
