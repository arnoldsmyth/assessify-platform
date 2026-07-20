import bcrypt from 'bcryptjs';

/**
 * PIN hashing port (spec 05: PINs are 6 digits, bcrypt-hashed at rest, never
 * logged or displayed). Injected into the respondent access service so tests
 * can use a cheap fake; the default provider is bcrypt (`bcryptjs` — pure JS,
 * no native build). bcrypt comparison does not short-circuit on the first
 * differing byte, which gives the constant-time behaviour spec 05 requires.
 *
 * PIN generation/issuance (order fulfilment, invitation resend) must reuse
 * `hash()` from this same port so verification always matches at-rest format.
 */
export interface PinHasher {
  hash(pin: string): Promise<string>;
  verify(pin: string, pinHash: string): Promise<boolean>;
}

/** bcrypt work factor — 6-digit PINs are low-entropy, so keep the cost real. */
export const PIN_BCRYPT_COST = 12;

export function createBcryptPinHasher(cost: number = PIN_BCRYPT_COST): PinHasher {
  return {
    hash(pin) {
      return bcrypt.hash(pin, cost);
    },
    async verify(pin, pinHash) {
      try {
        return await bcrypt.compare(pin, pinHash);
      } catch {
        // Malformed stored hash — treat as non-matching, never throw upward.
        return false;
      }
    },
  };
}
