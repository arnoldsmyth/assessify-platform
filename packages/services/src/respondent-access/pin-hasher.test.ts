import { describe, expect, it } from 'vitest';

import { createBcryptPinHasher } from './pin-hasher';

// Low cost keeps the suite fast; production uses PIN_BCRYPT_COST.
const hasher = createBcryptPinHasher(4);

describe('createBcryptPinHasher', () => {
  it('round-trips a PIN through hash and verify', async () => {
    const pinHash = await hasher.hash('123456');
    expect(pinHash).not.toContain('123456');
    await expect(hasher.verify('123456', pinHash)).resolves.toBe(true);
  });

  it('rejects a wrong PIN', async () => {
    const pinHash = await hasher.hash('123456');
    await expect(hasher.verify('654321', pinHash)).resolves.toBe(false);
  });

  it('treats a malformed stored hash as non-matching instead of throwing', async () => {
    await expect(hasher.verify('123456', 'not-a-bcrypt-hash')).resolves.toBe(false);
  });
});
