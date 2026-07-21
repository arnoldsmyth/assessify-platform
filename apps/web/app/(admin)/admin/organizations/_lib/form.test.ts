import { describe, expect, it } from 'vitest';

import { formStateFromError, parseOrganizationFormData, toFormValues } from './form';

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe('parseOrganizationFormData', () => {
  it('maps and trims the form fields', () => {
    expect(
      parseOrganizationFormData(
        formData({
          name: '  Insight Publishing ',
          slug: ' insight-publishing ',
          settlementEmail: ' billing@example.com ',
          settlementCurrency: 'usd',
        })
      )
    ).toEqual({
      name: 'Insight Publishing',
      slug: 'insight-publishing',
      settlementEmail: 'billing@example.com',
      settlementCurrency: 'USD',
    });
  });

  it('clears an empty settlement email to null and defaults the currency', () => {
    expect(parseOrganizationFormData(formData({ name: 'A', slug: 'a', settlementEmail: '' })))
      .toEqual({
        name: 'A',
        slug: 'a',
        settlementEmail: null,
        settlementCurrency: 'EUR',
      });
  });

  it('passes empty required fields through for the service schema to judge', () => {
    expect(parseOrganizationFormData(formData({}))).toEqual({
      name: '',
      slug: '',
      settlementEmail: null,
      settlementCurrency: 'EUR',
    });
  });
});

describe('formStateFromError', () => {
  it('maps validation issues onto field errors', () => {
    const state = formStateFromError({
      code: 'organization/validation',
      message: 'Organization payload failed validation',
      detail: {
        issues: [
          { path: 'slug', message: 'Must be at least 2 characters' },
          { path: 'slug', message: 'second issue is ignored' },
          { path: 'name', message: 'Required' },
        ],
      },
    });
    expect(state.status).toBe('error');
    expect(state.fieldErrors).toEqual({
      slug: 'Must be at least 2 characters',
      name: 'Required',
    });
  });

  it('pins slug_taken onto the slug field', () => {
    const state = formStateFromError({
      code: 'organization/slug_taken',
      message: 'The slug "acme" is already in use',
    });
    expect(state.fieldErrors).toEqual({ slug: 'The slug "acme" is already in use' });
  });

  it('falls back to the error message for other codes', () => {
    const state = formStateFromError({
      code: 'organization/forbidden',
      message: 'Only super admins can manage organizations',
    });
    expect(state).toEqual({
      status: 'error',
      message: 'Only super admins can manage organizations',
    });
  });
});

describe('toFormValues', () => {
  it('projects the client-safe fields', () => {
    expect(
      toFormValues({
        id: '01890000-0000-7000-8000-0000000000a1',
        name: 'PRO-D Publishing',
        slug: 'pro-d-publishing',
        status: 'active',
        connectedStripeAccountId: 'acct_123',
        settlementEmail: null,
        settlementCurrency: 'EUR',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })
    ).toEqual({
      name: 'PRO-D Publishing',
      slug: 'pro-d-publishing',
      settlementEmail: null,
      settlementCurrency: 'EUR',
    });
  });
});
