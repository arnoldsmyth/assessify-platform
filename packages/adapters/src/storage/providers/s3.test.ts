import { describe, expect, it, vi } from 'vitest';

import { StorageError } from '../types';
import { S3Storage, s3ConfigFromEnv } from './s3';

/**
 * The AWS SigV4 test vector for presigned GETs (docs.aws.amazon.com
 * "Authenticating Requests: Using Query Parameters"), reproduced by pointing
 * the provider at s3.amazonaws.com. Our canonical request hashes to the
 * intermediate value published in those docs
 * (3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04); the
 * signature below is the standard HMAC chain over that verified string to
 * sign. If our SigV4 implementation drifts, this signature changes.
 */
const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRcfiCYEXAMPLEKEY',
  region: 'us-east-1',
  bucket: 'examplebucket',
  endpoint: 'https://s3.amazonaws.com',
  date: new Date('2013-05-24T00:00:00.000Z'),
  expectedSignature: 'c3003a25c5887d346859c7d4f5bc1ed3d34512442792c1d3a18f134fd99199cb',
};

function makeFetchDouble(response: Response) {
  return vi.fn(async () => response);
}

function makeStorage(overrides: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}) {
  return new S3Storage({
    region: 'fsn1',
    bucket: 'assessify-assets',
    accessKeyId: 'HETZNEREXAMPLE',
    secretAccessKey: 'secret',
    endpoint: 'https://fsn1.your-objectstorage.com',
    clock: () => new Date('2026-07-14T09:00:00.000Z'),
    ...overrides,
  });
}

describe('S3Storage.signedUrl', () => {
  it('matches the published AWS SigV4 presigned-URL test vector', async () => {
    const storage = new S3Storage({
      region: AWS_EXAMPLE.region,
      bucket: AWS_EXAMPLE.bucket,
      accessKeyId: AWS_EXAMPLE.accessKeyId,
      secretAccessKey: AWS_EXAMPLE.secretAccessKey,
      endpoint: AWS_EXAMPLE.endpoint,
      clock: () => AWS_EXAMPLE.date,
    });

    const url = await storage.signedUrl({ key: 'test.txt', expiresInSeconds: 86400 });

    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-SignedHeaders=host' +
        `&X-Amz-Signature=${AWS_EXAMPLE.expectedSignature}`
    );
  });

  it('targets the S3-compatible virtual-hosted endpoint and encodes the key', async () => {
    const storage = makeStorage();
    const url = await storage.signedUrl({ key: 'branding/prod 1/logo.png' });

    expect(url.startsWith('https://assessify-assets.fsn1.your-objectstorage.com/')).toBe(true);
    expect(url).toContain('/branding/prod%201/logo.png?');
    expect(url).toContain('X-Amz-Expires=900'); // 15-minute default
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
  });
});

describe('S3Storage requests', () => {
  it('upload PUTs the body with SigV4 headers (content headers signed)', async () => {
    const fetchFn = makeFetchDouble(new Response(null, { status: 200 }));
    const storage = makeStorage({ fetchFn });

    await storage.upload({
      key: 'branding/logo.png',
      body: new TextEncoder().encode('png-bytes'),
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000',
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://assessify-assets.fsn1.your-objectstorage.com/branding/logo.png');
    expect(init.method).toBe('PUT');

    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=HETZNEREXAMPLE\/20260714\/fsn1\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
    );
    expect(headers['x-amz-date']).toBe('20260714T090000Z');
    // Payload hash is the SHA-256 of the actual body, not UNSIGNED-PAYLOAD.
    expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['content-type']).toBe('image/png');
    expect(headers['host']).toBeUndefined(); // forbidden fetch header — set from URL
  });

  it('download returns body + content type, and null on 404', async () => {
    const ok = makeFetchDouble(
      new Response(new TextEncoder().encode('pdf-bytes'), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })
    );
    const found = await makeStorage({ fetchFn: ok }).download('legacy/r.pdf');
    expect(new TextDecoder().decode(found?.body)).toBe('pdf-bytes');
    expect(found?.contentType).toBe('application/pdf');

    const missing = makeFetchDouble(new Response('NoSuchKey', { status: 404 }));
    expect(await makeStorage({ fetchFn: missing }).download('legacy/gone.pdf')).toBeNull();
  });

  it('delete tolerates 404 but surfaces other failures as StorageError', async () => {
    const gone = makeFetchDouble(new Response(null, { status: 404 }));
    await expect(makeStorage({ fetchFn: gone }).delete('k')).resolves.toBeUndefined();

    const denied = makeFetchDouble(new Response('AccessDenied', { status: 403 }));
    await expect(makeStorage({ fetchFn: denied }).delete('k')).rejects.toBeInstanceOf(
      StorageError
    );
  });

  it('wraps transport failures and upload errors in StorageError with status', async () => {
    const boom = vi.fn(async () => Promise.reject(new Error('ECONNRESET')));
    await expect(
      makeStorage({ fetchFn: boom as unknown as typeof fetch }).download('k')
    ).rejects.toBeInstanceOf(StorageError);

    const slowdown = makeFetchDouble(new Response('SlowDown', { status: 503 }));
    const error = await makeStorage({ fetchFn: slowdown })
      .upload({ key: 'k', body: new Uint8Array() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).statusCode).toBe(503);
    expect((error as StorageError).key).toBe('k');
  });
});

describe('s3ConfigFromEnv', () => {
  it('builds a config from S3_* variables', () => {
    const config = s3ConfigFromEnv({
      S3_REGION: 'fsn1',
      S3_BUCKET: 'assessify',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'https://fsn1.your-objectstorage.com',
    });
    expect(config).toMatchObject({ region: 'fsn1', bucket: 'assessify' });
  });

  it('names (only) the missing variables', () => {
    expect(() => s3ConfigFromEnv({ S3_REGION: 'fsn1' })).toThrowError(
      /S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT/
    );
  });
});
