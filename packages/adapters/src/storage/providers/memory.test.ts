import { describe, expect, it } from 'vitest';

import type { ObjectStorage } from '../types';
import { MemoryStorage } from './memory';

/**
 * Contract tests for the ObjectStorage interface, run against the memory
 * provider — the behavioral reference any provider must satisfy.
 */
function makeStorage(): MemoryStorage {
  return new MemoryStorage(() => new Date('2026-07-14T09:00:00.000Z'));
}

describe('ObjectStorage contract (MemoryStorage)', () => {
  it('round-trips upload → download with content type', async () => {
    const storage: ObjectStorage = makeStorage();
    const body = new TextEncoder().encode('logo-bytes');
    await storage.upload({ key: 'branding/prod-1/logo.png', body, contentType: 'image/png' });

    const downloaded = await storage.download('branding/prod-1/logo.png');
    expect(downloaded).not.toBeNull();
    expect(new TextDecoder().decode(downloaded?.body)).toBe('logo-bytes');
    expect(downloaded?.contentType).toBe('image/png');
  });

  it('returns null for a missing key', async () => {
    const storage: ObjectStorage = makeStorage();
    expect(await storage.download('nope/missing.pdf')).toBeNull();
  });

  it('overwrites an existing key on re-upload', async () => {
    const storage: ObjectStorage = makeStorage();
    const key = 'legacy-reports/abc.pdf';
    await storage.upload({ key, body: new TextEncoder().encode('v1') });
    await storage.upload({ key, body: new TextEncoder().encode('v2') });

    const downloaded = await storage.download(key);
    expect(new TextDecoder().decode(downloaded?.body)).toBe('v2');
  });

  it('delete removes the object and is idempotent', async () => {
    const storage = makeStorage();
    const key = 'branding/prod-1/favicon.ico';
    await storage.upload({ key, body: new Uint8Array([1, 2, 3]) });
    expect(storage.has(key)).toBe(true);

    await storage.delete(key);
    expect(storage.has(key)).toBe(false);
    await expect(storage.delete(key)).resolves.toBeUndefined(); // missing key is fine
  });

  it('stores a copy of the uploaded body (no aliasing)', async () => {
    const storage: ObjectStorage = makeStorage();
    const body = new Uint8Array([1, 2, 3]);
    await storage.upload({ key: 'k', body });
    body[0] = 99;

    const downloaded = await storage.download('k');
    expect(downloaded?.body[0]).toBe(1);
  });

  it('signedUrl encodes the key and carries method + expiry', async () => {
    const storage: ObjectStorage = makeStorage();
    const url = await storage.signedUrl({
      key: 'legacy reports/ORD 1.pdf',
      method: 'PUT',
      expiresInSeconds: 60,
    });
    expect(url).toContain('legacy%20reports/ORD%201.pdf');
    expect(url).toContain('method=PUT');
    expect(url).toContain('expires=2026-07-14T09:01:00.000Z');
  });

  it('signedUrl defaults to GET and 15 minutes', async () => {
    const storage: ObjectStorage = makeStorage();
    const url = await storage.signedUrl({ key: 'k.png' });
    expect(url).toContain('method=GET');
    expect(url).toContain('expires=2026-07-14T09:15:00.000Z');
  });
});
