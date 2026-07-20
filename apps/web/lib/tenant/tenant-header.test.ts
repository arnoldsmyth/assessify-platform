import type { TenantResolution } from '@assessify/services';
import { describe, expect, it } from 'vitest';

import { encodeTenantHeader, parseTenantHeader } from './tenant-header';

const productTenant: TenantResolution = {
  surface: 'product',
  productId: '01890000-0000-7000-8000-000000000001',
  productSlug: 'pro-d',
  productName: 'PRO-D Résumé', // non-ASCII must survive the header encoding
  clientId: null,
  via: 'custom_domain',
  branding: {
    logoUrl: 'https://cdn.example.com/logo.svg',
    colors: { primary: '#123456' },
    fontFamily: "'Alte Haas', Georgia, serif",
  },
};

describe('tenant header codec', () => {
  it('round-trips every surface shape', () => {
    for (const tenant of [
      { surface: 'admin' },
      { surface: 'platform' },
      productTenant,
    ] as TenantResolution[]) {
      expect(parseTenantHeader(encodeTenantHeader(tenant))).toEqual(tenant);
    }
  });

  it('produces an ASCII-safe header value', () => {
    expect(encodeTenantHeader(productTenant)).toMatch(/^[!-~]+$/);
  });

  it('returns null for absent or malformed values', () => {
    expect(parseTenantHeader(null)).toBeNull();
    expect(parseTenantHeader('')).toBeNull();
    expect(parseTenantHeader('not-json')).toBeNull();
    expect(parseTenantHeader(encodeURIComponent('{"surface":"nope"}'))).toBeNull();
    // Invalid branding inside an otherwise valid envelope → rejected whole.
    expect(
      parseTenantHeader(
        encodeURIComponent(
          JSON.stringify({ ...productTenant, branding: { logoUrl: 'javascript:alert(1)' } })
        )
      )
    ).toBeNull();
  });
});
