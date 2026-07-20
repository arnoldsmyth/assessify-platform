/**
 * Object storage adapter contract (appendix-architecture-layers.md §4
 * "Storage Adapter": upload, download, signed URLs — plus delete).
 *
 * Backends: DigitalOcean Spaces (S3-compatible) in production, in-memory for
 * tests/local. Services depend on this interface only; providers are wired at
 * composition roots. Used for branding assets and migrated legacy report PDFs
 * (A4 re-scope: Firebase Storage dropped).
 */

export interface StorageUploadInput {
  /** Object key, e.g. 'branding/{productId}/logo.png' — never contains PII. */
  key: string;
  body: Uint8Array;
  contentType?: string;
  /** e.g. 'public, max-age=31536000' for immutable branding assets. */
  cacheControl?: string;
}

export interface StorageObject {
  body: Uint8Array;
  contentType?: string;
}

export interface SignedUrlInput {
  key: string;
  /** Defaults to 900 (15 minutes). */
  expiresInSeconds?: number;
  /** GET (download link) or PUT (direct upload). Defaults to GET. */
  method?: 'GET' | 'PUT';
}

export interface ObjectStorage {
  upload(input: StorageUploadInput): Promise<void>;
  /** Returns null when the key does not exist. */
  download(key: string): Promise<StorageObject | null>;
  /** Time-limited URL for a private object (no auth needed to dereference). */
  signedUrl(input: SignedUrlInput): Promise<string>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** Transport/provider failure. Never includes object contents in messages. */
export class StorageError extends Error {
  readonly key?: string;
  readonly statusCode?: number;

  constructor(
    message: string,
    options: { key?: string; statusCode?: number; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StorageError';
    this.key = options.key;
    this.statusCode = options.statusCode;
  }
}
