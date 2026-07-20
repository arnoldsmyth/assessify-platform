/**
 * Stripe webhook (docs/spec/06-orders-and-state-machine.md: webhooks
 * `payment_intent.succeeded|payment_failed`, `charge.refunded`,
 * `checkout.session.completed` at /api/webhooks/stripe — verify signature,
 * translate to PaymentEvent, hand to paymentService.handleEvent()).
 *
 * Thin route per appendix-architecture-layers.md: API Route → Adapter
 * (verify signature FIRST, parse) → Service (handle). No business logic
 * here. Responses drive Stripe's retry behaviour: 401 bad signature, 400
 * malformed payload, 500 on processing failure (Stripe redelivers —
 * handleEvent is idempotent, so replays are safe); everything the service
 * chooses not to act on (unhandled types, unmatched refs, duplicates) is
 * acknowledged with 200 so Stripe stops retrying it.
 */
import { NextResponse } from 'next/server';
import {
  parseStripeEvent,
  STRIPE_SIGNATURE_HEADER,
  verifyStripeWebhookSignature,
} from '@assessify/adapters/payment/stripe';
import { PaymentWebhookPayloadError } from '@assessify/adapters';
import { getPaymentService } from '@assessify/services';

import { getServerEnv } from '@/lib/env';

// node:crypto signature verification — never run this on the edge runtime.
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const secret = getServerEnv().STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'stripe webhook is not configured' }, { status: 503 });
  }

  const signature = request.headers.get(STRIPE_SIGNATURE_HEADER);
  const payload = await request.text();
  if (
    !signature ||
    !verifyStripeWebhookSignature({ secret, payload, signatureHeader: signature })
  ) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let event;
  try {
    event = parseStripeEvent(JSON.parse(payload));
  } catch (cause) {
    if (cause instanceof PaymentWebhookPayloadError || cause instanceof SyntaxError) {
      return NextResponse.json({ error: 'malformed payload' }, { status: 400 });
    }
    throw cause;
  }

  // The webhook path never charges — no provider adapters needed.
  const result = await getPaymentService().handleEvent(event);
  if (!result.ok) {
    // Infrastructure failure — non-2xx makes Stripe redeliver the event.
    return NextResponse.json({ error: result.error.code }, { status: 500 });
  }

  return NextResponse.json({ received: event.eventId, outcome: result.value.outcome });
}
