import { describe, expect, it } from 'vitest';

import { formStateFromError, parseClientFormData, toFormValues } from './form';

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe('parseClientFormData', () => {
  it('maps and trims the form fields', () => {
    expect(
      parseClientFormData(
        formData({
          name: '  Acme Talent ',
          billingEmail: ' billing@example.com ',
          defaultCurrency: 'usd',
          timezone: ' Europe/Dublin ',
        })
      )
    ).toEqual({
      name: 'Acme Talent',
      billingEmail: 'billing@example.com',
      defaultCurrency: 'USD',
      timezone: 'Europe/Dublin',
    });
  });

  it('clears an empty billing email to null and defaults currency/timezone', () => {
    expect(parseClientFormData(formData({ name: 'Acme', billingEmail: '' }))).toEqual({
      name: 'Acme',
      billingEmail: null,
      defaultCurrency: 'EUR',
      timezone: 'Europe/Dublin',
    });
  });

  it('passes an empty required name through for the service schema to judge', () => {
    expect(parseClientFormData(formData({}))).toEqual({
      name: '',
      billingEmail: null,
      defaultCurrency: 'EUR',
      timezone: 'Europe/Dublin',
    });
  });

  it('includes organizationId only when the form actually rendered it (create form)', () => {
    const withOrg = parseClientFormData(
      formData({ name: 'Acme', organizationId: '01890000-0000-7000-8000-0000000000a1' })
    ) as Record<string, unknown>;
    expect(withOrg.organizationId).toBe('01890000-0000-7000-8000-0000000000a1');

    const withoutOrg = parseClientFormData(formData({ name: 'Acme' })) as Record<string, unknown>;
    expect('organizationId' in withoutOrg).toBe(false);
  });
});

describe('formStateFromError', () => {
  it('maps validation issues onto field errors', () => {
    const state = formStateFromError({
      code: 'client/validation',
      message: 'Client payload failed validation',
      detail: {
        issues: [
          { path: 'name', message: 'Required' },
          { path: 'name', message: 'second issue is ignored' },
          { path: 'billingEmail', message: 'Invalid email' },
        ],
      },
    });
    expect(state.status).toBe('error');
    expect(state.fieldErrors).toEqual({
      name: 'Required',
      billingEmail: 'Invalid email',
    });
  });

  it('pins organization_not_found onto the organizationId field', () => {
    const state = formStateFromError({
      code: 'client/organization_not_found',
      message: 'Organization not found',
    });
    expect(state.fieldErrors).toEqual({ organizationId: 'Organization not found' });
  });

  it('falls back to the error message for other codes', () => {
    const state = formStateFromError({
      code: 'client/forbidden',
      message: 'Only super admins or the organization’s own admins can create clients in it',
    });
    expect(state).toEqual({
      status: 'error',
      message: 'Only super admins or the organization’s own admins can create clients in it',
    });
  });
});

describe('toFormValues', () => {
  it('projects the client-safe fields', () => {
    expect(
      toFormValues({
        id: '01890000-0000-7000-8000-00000000c001',
        organizationId: '01890000-0000-7000-8000-0000000000a1',
        clientNumber: 7,
        name: 'Acme Talent',
        billingEmail: 'billing@example.com',
        billingAddress: null,
        defaultCurrency: 'EUR',
        xeroContactId: null,
        timezone: 'Europe/Dublin',
        notificationOverrides: null,
        source: 'native',
        legacyId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      })
    ).toEqual({
      name: 'Acme Talent',
      billingEmail: 'billing@example.com',
      defaultCurrency: 'EUR',
      timezone: 'Europe/Dublin',
    });
  });
});
