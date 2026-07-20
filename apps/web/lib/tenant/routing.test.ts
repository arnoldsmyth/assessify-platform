import { describe, expect, it } from 'vitest';

import { isPathAllowedForSurface } from './routing';

describe('isPathAllowedForSurface', () => {
  it('serves everything on admin hosts (dev: localhost serves all surfaces)', () => {
    for (const path of ['/admin', '/admin/orders', '/login', '/access', '/a/tok123', '/']) {
      expect(isPathAllowedForSurface('admin', path)).toBe(true);
    }
  });

  it('404s admin routes on white-label product hosts (spec 11)', () => {
    expect(isPathAllowedForSurface('product', '/admin')).toBe(false);
    expect(isPathAllowedForSurface('product', '/admin/orders/123')).toBe(false);
    expect(isPathAllowedForSurface('product', '/login')).toBe(false);
  });

  it('serves respondent and public routes on product hosts', () => {
    for (const path of ['/', '/access', '/a/tok123', '/a/tok123/q', '/questionnaire']) {
      expect(isPathAllowedForSurface('product', path)).toBe(true);
    }
  });

  it('does not treat lookalike prefixes as admin routes', () => {
    expect(isPathAllowedForSurface('product', '/administrator-guide')).toBe(true);
    expect(isPathAllowedForSurface('product', '/logins')).toBe(true);
  });

  it('404s admin routes on the platform apex', () => {
    expect(isPathAllowedForSurface('platform', '/admin')).toBe(false);
    expect(isPathAllowedForSurface('platform', '/')).toBe(true);
  });
});
