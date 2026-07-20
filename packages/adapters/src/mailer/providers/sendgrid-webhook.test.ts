import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  parseSendGridEvents,
  SendGridWebhookPayloadError,
  verifySendGridWebhookSignature,
} from './sendgrid-webhook';

const PAYLOAD = JSON.stringify([{ event: 'delivered', sg_message_id: 'abc.def' }]);
const TIMESTAMP = '1752912000';

function ed25519Fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signature = cryptoSign(null, Buffer.from(TIMESTAMP + PAYLOAD, 'utf8'), privateKey);
  return {
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    signature: signature.toString('base64'),
  };
}

function ecdsaFixture() {
  // SendGrid's console issues ECDSA keys; verification is SHA-256 over
  // timestamp + payload with a DER signature.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signature = cryptoSign('sha256', Buffer.from(TIMESTAMP + PAYLOAD, 'utf8'), privateKey);
  return {
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    signature: signature.toString('base64'),
  };
}

describe('verifySendGridWebhookSignature', () => {
  it('accepts a valid Ed25519 signature (base64 DER key)', () => {
    const { publicKeyBase64, signature } = ed25519Fixture();
    expect(
      verifySendGridWebhookSignature({
        publicKey: publicKeyBase64,
        payload: PAYLOAD,
        signature,
        timestamp: TIMESTAMP,
      })
    ).toBe(true);
  });

  it('accepts a PEM-formatted public key', () => {
    const { publicKeyPem, signature } = ed25519Fixture();
    expect(
      verifySendGridWebhookSignature({
        publicKey: publicKeyPem,
        payload: PAYLOAD,
        signature,
        timestamp: TIMESTAMP,
      })
    ).toBe(true);
  });

  it('accepts a valid ECDSA (P-256) signature', () => {
    const { publicKeyBase64, signature } = ecdsaFixture();
    expect(
      verifySendGridWebhookSignature({
        publicKey: publicKeyBase64,
        payload: PAYLOAD,
        signature,
        timestamp: TIMESTAMP,
      })
    ).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const { publicKeyBase64, signature } = ed25519Fixture();
    expect(
      verifySendGridWebhookSignature({
        publicKey: publicKeyBase64,
        payload: PAYLOAD.replace('delivered', 'bounce'),
        signature,
        timestamp: TIMESTAMP,
      })
    ).toBe(false);
  });

  it('rejects a shifted timestamp (replay protection input)', () => {
    const { publicKeyBase64, signature } = ed25519Fixture();
    expect(
      verifySendGridWebhookSignature({
        publicKey: publicKeyBase64,
        payload: PAYLOAD,
        signature,
        timestamp: '1752912001',
      })
    ).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const { signature } = ed25519Fixture();
    const other = ed25519Fixture();
    expect(
      verifySendGridWebhookSignature({
        publicKey: other.publicKeyBase64,
        payload: PAYLOAD,
        signature,
        timestamp: TIMESTAMP,
      })
    ).toBe(false);
  });

  it('returns false (never throws) on garbage key or signature', () => {
    expect(
      verifySendGridWebhookSignature({
        publicKey: 'not-a-key',
        payload: PAYLOAD,
        signature: 'not-a-signature',
        timestamp: TIMESTAMP,
      })
    ).toBe(false);
  });
});

describe('parseSendGridEvents', () => {
  it('normalises tracked event types and strips the sg_message_id suffix', () => {
    const events = parseSendGridEvents([
      {
        event: 'delivered',
        sg_message_id: 'msg-1.filter001.recv',
        timestamp: 1752912000,
        email: 'someone@example.com',
      },
      { event: 'open', sg_message_id: 'msg-1.filter001.recv' },
      { event: 'bounce', sg_message_id: 'msg-2' },
      { event: 'dropped', notification_id: '01890a5d-ac96-774b-bcce-b302099a8057' },
    ]);
    expect(events).toEqual([
      {
        type: 'delivered',
        providerMessageId: 'msg-1',
        notificationId: null,
        occurredAt: new Date(1752912000 * 1000),
      },
      { type: 'opened', providerMessageId: 'msg-1', notificationId: null, occurredAt: null },
      { type: 'bounced', providerMessageId: 'msg-2', notificationId: null, occurredAt: null },
      {
        type: 'dropped',
        providerMessageId: null,
        notificationId: '01890a5d-ac96-774b-bcce-b302099a8057',
        occurredAt: null,
      },
    ]);
  });

  it('does not surface recipient email addresses (PII stays in the raw payload)', () => {
    const [event] = parseSendGridEvents([
      { event: 'delivered', sg_message_id: 'm.1', email: 'someone@example.com' },
    ]);
    expect(JSON.stringify(event)).not.toContain('someone@example.com');
  });

  it('skips unknown event types and malformed entries', () => {
    const events = parseSendGridEvents([
      { event: 'processed', sg_message_id: 'm.1' },
      { event: 'totally_new_event', sg_message_id: 'm.2' },
      { not: 'an event' },
      42,
    ]);
    expect(events).toEqual([
      { type: 'processed', providerMessageId: 'm', notificationId: null, occurredAt: null },
    ]);
  });

  it('throws SendGridWebhookPayloadError when the body is not an array', () => {
    expect(() => parseSendGridEvents({ event: 'delivered' })).toThrow(
      SendGridWebhookPayloadError
    );
  });
});
