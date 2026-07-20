/**
 * SendGrid event webhook (docs/spec/13-notifications-and-reminders.md:
 * delivered/open/bounce → notification_log status; signature-verified).
 *
 * Thin route per appendix-architecture-layers.md: API Route → Adapter
 * (verify signature, parse events) → Service (apply to notification_log).
 * No business logic here; unmatched events are acknowledged (200) so
 * SendGrid does not retry them forever, while processing failures return
 * 500 so the batch IS retried.
 */
import { NextResponse } from 'next/server';
import {
  parseSendGridEvents,
  SENDGRID_SIGNATURE_HEADER,
  SENDGRID_TIMESTAMP_HEADER,
  SendGridWebhookPayloadError,
  verifySendGridWebhookSignature,
} from '@assessify/adapters/mailer/sendgrid-webhook';
import { getNotificationService } from '@assessify/services';

import { getServerEnv } from '@/lib/env';

// node:crypto signature verification — never run this on the edge runtime.
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const publicKey = getServerEnv().SENDGRID_WEBHOOK_PUBLIC_KEY;
  if (!publicKey) {
    return NextResponse.json(
      { error: 'sendgrid webhook is not configured' },
      { status: 503 }
    );
  }

  const signature = request.headers.get(SENDGRID_SIGNATURE_HEADER);
  const timestamp = request.headers.get(SENDGRID_TIMESTAMP_HEADER);
  const payload = await request.text();
  if (
    !signature ||
    !timestamp ||
    !verifySendGridWebhookSignature({ publicKey, payload, signature, timestamp })
  ) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let events;
  try {
    events = parseSendGridEvents(JSON.parse(payload));
  } catch (cause) {
    if (cause instanceof SendGridWebhookPayloadError || cause instanceof SyntaxError) {
      return NextResponse.json({ error: 'malformed payload' }, { status: 400 });
    }
    throw cause;
  }

  // Webhook path only reads/updates the log — no mailer or queue needed.
  const notifications = getNotificationService();
  let applied = 0;
  for (const event of events) {
    const result = await notifications.recordProviderEvent(event);
    if (!result.ok) {
      // Infrastructure failure — non-2xx makes SendGrid redeliver the batch
      // (recordProviderEvent is idempotent, so replays are safe).
      return NextResponse.json({ error: result.error.code }, { status: 500 });
    }
    if (result.value.changed) applied += 1;
  }

  return NextResponse.json({ received: events.length, applied });
}
