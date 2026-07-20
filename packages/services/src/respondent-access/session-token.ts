import {
  respondentSessionPayloadSchema,
  type RespondentSessionPayload,
} from '@assessify/domain';

/**
 * Compact HMAC-SHA256-signed respondent session token (spec 05: signed
 * `resp_session` cookie value, `{sessionId, exp}`, 24h).
 *
 * Format: `v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(v1.payload))>`
 *
 * Implemented over the WebCrypto global (Node >= 19 and all evergreen
 * runtimes) with zero dependencies — this package compiles with lib ES2022
 * only, hence the minimal ambient declarations below (same pattern as
 * `@assessify/domain`'s uuidv7). The signing key is injected via service
 * config; nothing here reads the environment.
 */

// Minimal WebCrypto surface (no DOM lib in this package's tsconfig).
declare const crypto: {
  subtle: {
    importKey(
      format: 'raw',
      keyData: Uint8Array,
      algorithm: { name: 'HMAC'; hash: 'SHA-256' },
      extractable: boolean,
      keyUsages: readonly ['sign']
    ): Promise<unknown>;
    sign(algorithm: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  };
};

const TOKEN_VERSION = 'v1';
const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** UTF-8 encode without TextEncoder (not in lib ES2022). */
function utf8Bytes(input: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const code = input.codePointAt(i) ?? 0;
    if (code > 0xffff) i += 1; // consumed a surrogate pair
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return Uint8Array.from(bytes);
}

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET.charAt(b0 >> 2);
    out += BASE64URL_ALPHABET.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    if (b1 === undefined) break;
    out += BASE64URL_ALPHABET.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    if (b2 === undefined) break;
    out += BASE64URL_ALPHABET.charAt(b2 & 0x3f);
  }
  return out;
}

function fromBase64Url(input: string): Uint8Array | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of input) {
    const value = BASE64URL_ALPHABET.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** Payloads are ASCII JSON by construction; reject anything else. */
function asciiString(bytes: Uint8Array): string | null {
  let out = '';
  for (const byte of bytes) {
    if (byte >= 0x80) return null;
    out += String.fromCharCode(byte);
  }
  return out;
}

async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    utf8Bytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, utf8Bytes(message)));
}

/** Constant-time byte comparison — never short-circuits on a mismatch. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Sign a session payload into the opaque cookie value. */
export async function signSessionPayload(
  signingKey: string,
  payload: RespondentSessionPayload
): Promise<string> {
  const body = toBase64Url(utf8Bytes(JSON.stringify(payload)));
  const mac = await hmacSha256(signingKey, `${TOKEN_VERSION}.${body}`);
  return `${TOKEN_VERSION}.${body}.${toBase64Url(mac)}`;
}

/**
 * Verify signature + shape. Returns the payload, or null for anything
 * malformed or tampered. Expiry is the caller's concern (needs a clock).
 */
export async function verifySessionPayload(
  signingKey: string,
  token: string
): Promise<RespondentSessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, body, signature] = parts;
  if (version !== TOKEN_VERSION || body === undefined || signature === undefined) return null;

  const givenMac = fromBase64Url(signature);
  if (givenMac === null) return null;
  const expectedMac = await hmacSha256(signingKey, `${version}.${body}`);
  if (!constantTimeEqual(givenMac, expectedMac)) return null;

  const bodyBytes = fromBase64Url(body);
  if (bodyBytes === null) return null;
  const json = asciiString(bodyBytes);
  if (json === null) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = respondentSessionPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
