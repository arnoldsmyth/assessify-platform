import type { ObjectStorage, SignedUrlInput, StorageObject, StorageUploadInput } from '../types';

/**
 * In-memory ObjectStorage provider for tests and local development.
 * Signed URLs are fake but stable in shape (`memory://…`) so code that
 * threads them around can be exercised without a network.
 */
export class MemoryStorage implements ObjectStorage {
  private readonly objects = new Map<string, { body: Uint8Array; contentType?: string }>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async upload(input: StorageUploadInput): Promise<void> {
    // Copy the body so later mutation of the caller's buffer can't corrupt the store.
    this.objects.set(input.key, {
      body: new Uint8Array(input.body),
      contentType: input.contentType,
    });
  }

  async download(key: string): Promise<StorageObject | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return { body: new Uint8Array(stored.body), contentType: stored.contentType };
  }

  async signedUrl(input: SignedUrlInput): Promise<string> {
    const method = input.method ?? 'GET';
    const expiresInSeconds = input.expiresInSeconds ?? 900;
    const expiresAt = new Date(this.clock().getTime() + expiresInSeconds * 1000);
    const encodedKey = input.key.split('/').map(encodeURIComponent).join('/');
    return `memory://storage/${encodedKey}?method=${method}&expires=${expiresAt.toISOString()}`;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  // -- test helpers -------------------------------------------------------

  has(key: string): boolean {
    return this.objects.has(key);
  }

  size(): number {
    return this.objects.size;
  }

  clear(): void {
    this.objects.clear();
  }
}
