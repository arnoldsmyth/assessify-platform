/**
 * SendGrid signed event webhook: signature verification + event parsing
 * (docs/spec/13-notifications-and-reminders.md — `/api/webhooks/sendgrid`,
 * signature-verified; appendix-architecture-layers.md — API Route → Adapter
 * (parse/validate) → Service (handle)).
 *
 * SendGrid signs `timestamp + rawBody` and sends the base64 signature in
 * `X-Twilio-Email-Event-Webhook-Signature` plus the timestamp in
 * `X-Twilio-Email-Event-Webhook-Timestamp`. The verification public key is
 * injected (env at the composition root, never hardcoded). Key type is
 * detected from the key itself, so both Ed25519 keys and SendGrid's ECDSA
 * keys (verified as SHA-256/DER, the format their console issues) work.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

import type { MailEventType, MailProviderEvent } from '../types';

export const SENDGRID_SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const SENDGRID_TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

/** Accepts a PEM public key or SendGrid's raw base64 (DER, SPKI) form. */
export function parseSendGridPublicKey(publicKey: string): KeyObject {
  const trimmed = publicKey.trim();
  if (trimmed.includes('BEGIN PUBLIC KEY')) {
    return createPublicKey(trimmed);
  }
  return createPublicKey({
    key: Buffer.from(trimmed, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

export interface VerifySignatureInput {
  /** PEM or base64-DER public key (from env — never hardcode). */
  publicKey: string | KeyObject;
  /** Raw request body, byte-for-byte as received. */
  payload: string;
  /** Base64 signature from {@link SENDGRID_SIGNATURE_HEADER}. */
  signature: string;
  /** Timestamp string from {@link SENDGRID_TIMESTAMP_HEADER}. */
  timestamp: string;
}

/**
 * Verify a signed event webhook request. Returns false (never throws) on any
 * malformed key/signature so the route can reply 401 uniformly.
 */
export function verifySendGridWebhookSignature(input: VerifySignatureInput): boolean {
  try {
    const key =
      typeof input.publicKey === 'string' ? parseSendGridPublicKey(input.publicKey) : input.publicKey;
    const data = Buffer.from(input.timestamp + input.payload, 'utf8');
    const signature = Buffer.from(input.signature, 'base64');
    // Ed25519 signs the raw message; EC/RSA keys verify over SHA-256.
    const algorithm = key.asymmetricKeyType === 'ed25519' ? null : 'sha256';
    return cryptoVerify(algorithm, data, key, signature);
  } catch {
    return false;
  }
}

/** SendGrid event names → normalised MailEventType. Unknown events are skipped. */
const EVENT_TYPES: Record<string, MailEventType> = {
  processed: 'processed',
  delivered: 'delivered',
  open: 'opened',
  click: 'clicked',
  bounce: 'bounced',
  dropped: 'dropped',
  deferred: 'deferred',
  spamreport: 'spam_report',
  unsubscribe: 'unsubscribed',
  group_unsubscribe: 'unsubscribed',
};

/**
 * One raw webhook event. `.passthrough()` because SendGrid adds fields per
 * event type (and echoes custom args at the top level) — we only read what we
 * need and never persist the rest (the `email` field is PII: not extracted).
 */
const sendGridEventSchema = z
  .object({
    event: z.string(),
    sg_message_id: z.string().optional(),
    timestamp: z.number().int().optional(),
    /** Custom arg set by the SendGrid mailer provider for correlation. */
    notification_id: z.string().uuid().optional(),
  })
  .passthrough();

const sendGridEventBatchSchema = z.array(z.unknown());

/** Thrown when the (already signature-verified) payload is not an event batch. */
export class SendGridWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendGridWebhookPayloadError';
  }
}

/**
 * Parse a verified webhook body into normalised provider events. Individual
 * events that are malformed or of an unhandled type are skipped (SendGrid
 * batches many event kinds we do not track); a body that is not an array at
 * all throws {@link SendGridWebhookPayloadError} → respond 400.
 */
export function parseSendGridEvents(body: unknown): MailProviderEvent[] {
  const batch = sendGridEventBatchSchema.safeParse(body);
  if (!batch.success) {
    throw new SendGridWebhookPayloadError('webhook payload is not an event array');
  }
  const events: MailProviderEvent[] = [];
  for (const raw of batch.data) {
    const parsed = sendGridEventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const type = EVENT_TYPES[parsed.data.event];
    if (!type) continue;
    events.push({
      type,
      // sg_message_id = "<X-Message-Id>.<internal-suffix>" — keep the prefix,
      // which is what the send API returned and the log stores.
      providerMessageId: parsed.data.sg_message_id?.split('.')[0] ?? null,
      notificationId: parsed.data.notification_id ?? null,
      occurredAt:
        parsed.data.timestamp !== undefined ? new Date(parsed.data.timestamp * 1000) : null,
    });
  }
  return events;
}
