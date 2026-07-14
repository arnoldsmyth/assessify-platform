/**
 * UUIDv7 generator (spec 03/04: UUIDv7 primary keys — time-ordered, so
 * b-tree friendly). Pure implementation over the WebCrypto global available
 * in Node >= 19 and all evergreen browsers; no dependencies so the domain
 * package stays innermost.
 */

// Minimal module-scoped declaration: the domain package compiles with lib
// ES2022 only (no DOM lib), so the WebCrypto global is not typed.
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };

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
