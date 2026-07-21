import { createHash, createHmac } from 'node:crypto';

import {
  StorageError,
  type ObjectStorage,
  type SignedUrlInput,
  type StorageObject,
  type StorageUploadInput,
} from '../types';

/**
 * Generic S3-compatible object storage provider (virtual-hosted style REST
 * API) with hand-rolled AWS Signature v4 over node:crypto — no AWS SDK
 * dependency. Works against any S3-compatible backend (Hetzner Object
 * Storage, DigitalOcean Spaces, MinIO, AWS S3 itself, ...) — the provider
 * has no built-in assumptions about which one; `endpoint` is always explicit.
 * Verified against the published AWS SigV4 test vectors (see s3.test.ts).
 */

export interface S3StorageConfig {
  /** Signing region, e.g. 'fsn1' (Hetzner), 'ams3' (DO), 'us-east-1' (AWS). */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Origin, e.g. `https://fsn1.your-objectstorage.com` (Hetzner). Required — no default provider. */
  endpoint: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Injectable for deterministic signatures in tests. */
  clock?: () => Date;
}

/**
 * Build an S3StorageConfig from environment variables (composition roots
 * only). Throws StorageError naming the missing variables — never their values.
 */
export function s3ConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): S3StorageConfig {
  const required = {
    region: env['S3_REGION'],
    bucket: env['S3_BUCKET'],
    accessKeyId: env['S3_ACCESS_KEY_ID'],
    secretAccessKey: env['S3_SECRET_ACCESS_KEY'],
    endpoint: env['S3_ENDPOINT'],
  };
  const missing = Object.entries({
    S3_REGION: required.region,
    S3_BUCKET: required.bucket,
    S3_ACCESS_KEY_ID: required.accessKeyId,
    S3_SECRET_ACCESS_KEY: required.secretAccessKey,
    S3_ENDPOINT: required.endpoint,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new StorageError(`Missing S3 configuration: ${missing.join(', ')}`);
  }
  return {
    region: required.region as string,
    bucket: required.bucket as string,
    accessKeyId: required.accessKeyId as string,
    secretAccessKey: required.secretAccessKey as string,
    endpoint: required.endpoint as string,
  };
}

// ---------------------------------------------------------------------------
// SigV4 primitives
// ---------------------------------------------------------------------------

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** AWS canonical URI-encoding (RFC 3986, uppercase hex, '/' optionally kept). */
function uriEncode(input: string, encodeSlash: boolean): string {
  let out = '';
  for (const ch of input) {
    if (UNRESERVED.test(ch) || (!encodeSlash && ch === '/')) {
      out += ch;
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/** 20130524T000000Z */
function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class S3Storage implements ObjectStorage {
  private readonly host: string;
  private readonly protocol: string;
  private readonly fetchFn: typeof fetch;
  private readonly clock: () => Date;

  constructor(private readonly config: S3StorageConfig) {
    const endpoint = new URL(config.endpoint);
    this.host = `${config.bucket}.${endpoint.host}`;
    this.protocol = endpoint.protocol;
    this.fetchFn = config.fetchFn ?? fetch;
    this.clock = config.clock ?? (() => new Date());
  }

  async upload(input: StorageUploadInput): Promise<void> {
    const extraHeaders: Record<string, string> = {};
    if (input.contentType) extraHeaders['content-type'] = input.contentType;
    if (input.cacheControl) extraHeaders['cache-control'] = input.cacheControl;

    const response = await this.send('PUT', input.key, {
      body: input.body,
      extraHeaders,
    });
    if (!response.ok) {
      throw await this.responseError('upload', input.key, response);
    }
  }

  async download(key: string): Promise<StorageObject | null> {
    const response = await this.send('GET', key, {});
    if (response.status === 404) return null;
    if (!response.ok) {
      throw await this.responseError('download', key, response);
    }
    return {
      body: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? undefined,
    };
  }

  async signedUrl(input: SignedUrlInput): Promise<string> {
    const method = input.method ?? 'GET';
    const expiresInSeconds = input.expiresInSeconds ?? 900;
    const now = this.clock();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const canonicalUri = `/${uriEncode(input.key, false)}`;

    const query: [string, string][] = [
      ['X-Amz-Algorithm', ALGORITHM],
      ['X-Amz-Credential', `${this.config.accessKeyId}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(expiresInSeconds)],
      ['X-Amz-SignedHeaders', 'host'],
    ];
    const canonicalQuery = query
      .map(([name, value]) => [uriEncode(name, true), uriEncode(value, true)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      `host:${this.host}\n`,
      'host',
      UNSIGNED_PAYLOAD,
    ].join('\n');

    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac(
      'sha256',
      signingKey(this.config.secretAccessKey, dateStamp, this.config.region)
    )
      .update(stringToSign, 'utf8')
      .digest('hex');

    return (
      `${this.protocol}//${this.host}${canonicalUri}` +
      `?${canonicalQuery}&X-Amz-Signature=${signature}`
    );
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', key, {});
    // Idempotent per the adapter contract: a missing key is not an error.
    if (!response.ok && response.status !== 404) {
      throw await this.responseError('delete', key, response);
    }
  }

  // -- internals ----------------------------------------------------------

  /** Header-signed (SigV4) request to the object endpoint. */
  private async send(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    options: { body?: Uint8Array; extraHeaders?: Record<string, string> }
  ): Promise<Response> {
    const now = this.clock();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const canonicalUri = `/${uriEncode(key, false)}`;
    const payloadHash = sha256Hex(options.body ?? '');

    // All request headers are signed. 'host' participates in the signature
    // but is set by fetch from the URL (it is a forbidden request header).
    const headers: Record<string, string> = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
      headers[name.toLowerCase()] = value;
    }
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${headers[name]?.trim() ?? ''}\n`)
      .join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac(
      'sha256',
      signingKey(this.config.secretAccessKey, dateStamp, this.config.region)
    )
      .update(stringToSign, 'utf8')
      .digest('hex');

    const requestHeaders: Record<string, string> = { ...headers };
    delete requestHeaders['host'];
    requestHeaders['authorization'] =
      `${ALGORITHM} Credential=${this.config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    try {
      return await this.fetchFn(`${this.protocol}//${this.host}${canonicalUri}`, {
        method,
        headers: requestHeaders,
        body: options.body,
      });
    } catch (cause) {
      throw new StorageError(`S3 ${method} request failed`, { key, cause });
    }
  }

  private async responseError(
    operation: string,
    key: string,
    response: Response
  ): Promise<StorageError> {
    // S3 error bodies are XML without secrets; truncate defensively.
    const body = (await response.text().catch(() => '')).slice(0, 500);
    return new StorageError(
      `S3 ${operation} failed with status ${response.status}${body ? `: ${body}` : ''}`,
      { key, statusCode: response.status }
    );
  }
}
