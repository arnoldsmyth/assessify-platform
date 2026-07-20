/**
 * UUIDv7 generator (spec 03/04: UUIDv7 primary keys — time-ordered, so
 * b-tree friendly). Pure implementation over the WebCrypto global available
 * in Node >= 19 and all evergreen browsers; no dependencies so the domain
 * package stays innermost.
 */

// Minimal module-scoped declaration: the domain package compiles with lib
// ES2022 only (no DOM lib), so the WebCrypto global is not typed.
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

/**
 * UUIDv4 generator — fully random (RFC 9562 §5.4). Used where time ordering
 * must NOT leak, e.g. respondent session tokens (spec 05: "Tokens: UUIDv4
 * random (not v7 — no time ordering leakage)").
 */
export function uuid4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Version nibble 0100, variant bits 10xx.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}` +
    `-${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

export function uuidv7(timestamp: number = Date.now()): string {
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  let hex = '';
  for (const byte of rand) {
    hex += byte.toString(16).padStart(2, '0');
  }

  // 48-bit big-endian unix timestamp in milliseconds.
  const ts = Math.max(0, Math.trunc(timestamp)).toString(16).padStart(12, '0').slice(-12);
  // Variant nibble: 10xx (RFC 9562).
  const variantNibble = ((parseInt(hex.charAt(3), 16) & 0x3) | 0x8).toString(16);

  return (
    `${ts.slice(0, 8)}-${ts.slice(8, 12)}` +
    `-7${hex.slice(0, 3)}-${variantNibble}${hex.slice(4, 7)}-${hex.slice(7, 19)}`
  );
}
