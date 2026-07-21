import { describe, expect, it } from 'vitest';

import { parseProductFormData } from './form';

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const ORG_ID = '01890000-0000-7000-8000-0000000000a1';

describe('parseProductFormData — organization picker (M4)', () => {
  it('includes organizationId when the create form renders the picker', () => {
    const payload = parseProductFormData(
      formData({ organizationId: ORG_ID, name: 'PRO-D', slug: 'pro-d' })
    ) as Record<string, unknown>;
    expect(payload.organizationId).toBe(ORG_ID);
  });

  it('keeps an empty selection so the schema reports it on the field', () => {
    const payload = parseProductFormData(
      formData({ organizationId: '', name: 'PRO-D', slug: 'pro-d' })
    ) as Record<string, unknown>;
    expect(payload.organizationId).toBe('');
  });

  it('omits organizationId entirely when the field is absent (edit form — strict update schema)', () => {
    const payload = parseProductFormData(formData({ name: 'PRO-D', slug: 'pro-d' })) as Record<
      string,
      unknown
    >;
    expect('organizationId' in payload).toBe(false);
  });
});

describe('parseProductFormData — default access (M4)', () => {
  it('maps the checkbox onto defaultAccess', () => {
    const on = parseProductFormData(
      formData({ name: 'P', slug: 'p', defaultAccess: 'on' })
    ) as Record<string, unknown>;
    expect(on.defaultAccess).toBe(true);

    const off = parseProductFormData(formData({ name: 'P', slug: 'p' })) as Record<
      string,
      unknown
    >;
    expect(off.defaultAccess).toBe(false);
  });
});

describe('parseProductFormData — existing mapping', () => {
  it('shapes languages and retail fields as before', () => {
    const payload = parseProductFormData(
      formData({
        name: 'PRO-D',
        slug: 'pro-d',
        availableLanguages: 'en, fr',
        defaultLanguage: 'en',
        retailEnabled: 'on',
        retailPrice: '4950',
        retailCurrency: 'EUR',
      })
    ) as Record<string, unknown>;
    expect(payload.availableLanguages).toEqual(['en', 'fr']);
    expect(payload.retailEnabled).toBe(true);
    expect(payload.retailPrice).toBe(4950);
    expect(payload.retailCurrency).toBe('EUR');
  });
});
