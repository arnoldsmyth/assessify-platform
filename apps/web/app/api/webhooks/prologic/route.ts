/**
 * Pro-Logic `scored` webhook (E2 — docs/pro-logic-openapi.json
 * `webhooks.scored`): POSTed to our webhook URL after each successful
 * scoring call; HMAC-SHA256 of the RAW body in `X-Signature`, event name in
 * `X-Event`; retried with backoff on non-2xx.
 *
 * Because `POST /score` is synchronous, the adapter normally applies scores
 * inline and this webhook is a REDUNDANT confirmation — applyScores is
 * replay-idempotent, so re-applying is a no-op. Its real job is the rescue
 * path: Pro-Logic scored but our read of the response failed, leaving the
 * job dispatched with only `request_payload.externalRef` persisted.
 *
 * Thin route per appendix-architecture-layers.md: API Route → Adapter
 * (verify signature FIRST on the raw body, parse envelope) → Service
 * (resolve job by external ref, apply scores). Response semantics drive
 * Pro-Logic's retry behaviour: 401 bad signature, 400 malformed payload,
 * 404 unknown assessment ref (redelivery may find the job once our worker
 * persists it — a benign race), 500 processing failure (redelivered; safe
 * because applyScores is idempotent); non-`scored` events are acknowledged
 * with 200 so they are not retried forever. The envelope carries ids, keys
 * and numbers only — no PII to guard in logs.
 */
import { NextResponse } from 'next/server';
import {
  normalizePrologicEnvelope,
  parsePrologicScoredEvent,
  PROLOGIC_EVENT_HEADER,
  PROLOGIC_PROVIDER,
  PROLOGIC_SCORED_EVENT,
  PROLOGIC_SIGNATURE_HEADER,
  PrologicWebhookPayloadError,
  verifyPrologicWebhookSignature,
} from '@assessify/adapters/scoring/prologic';
import { getScoringService } from '@assessify/services';

import { getServerEnv } from '@/lib/env';

// node:crypto signature verification — never run this on the edge runtime.
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const secret = getServerEnv().PROLOGIC_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'prologic webhook is not configured' }, { status: 503 });
  }

  const signature = request.headers.get(PROLOGIC_SIGNATURE_HEADER);
  const payload = await request.text();
  if (!signature || !verifyPrologicWebhookSignature({ secret, payload, signature })) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  // Only `scored` carries a result envelope; ack anything else so the
  // engine does not redeliver events we will never act on.
  const event = request.headers.get(PROLOGIC_EVENT_HEADER);
  if (event !== null && event !== PROLOGIC_SCORED_EVENT) {
    return NextResponse.json({ ignored: event });
  }

  let envelope;
  try {
    envelope = parsePrologicScoredEvent(JSON.parse(payload));
  } catch (cause) {
    if (cause instanceof PrologicWebhookPayloadError || cause instanceof SyntaxError) {
      return NextResponse.json({ error: 'malformed payload' }, { status: 400 });
    }
    throw cause;
  }

  // The webhook path never scores — no queue or engine adapters needed.
  const result = await getScoringService().applyExternalScores(
    { provider: PROLOGIC_PROVIDER, assessmentId: envelope.assessment_id },
    normalizePrologicEnvelope(envelope)
  );
  if (!result.ok) {
    if (result.error.code === 'scoring/external_ref_unknown') {
      // Redelivery with backoff may find the job once processJob persists
      // the ref — see the module docs.
      return NextResponse.json({ error: result.error.code }, { status: 404 });
    }
    return NextResponse.json({ error: result.error.code }, { status: 500 });
  }

  return NextResponse.json({ applied: result.value.jobId, status: result.value.status });
}
