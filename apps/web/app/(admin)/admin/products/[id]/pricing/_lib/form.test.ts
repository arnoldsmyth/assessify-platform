import { describe, expect, it } from 'vitest';

import {
  formatMinor,
  parseMoneyToMinor,
  parsePriceFormData,
  priceStateFromError,
} from './form';

const PRODUCT_ID = '01890000-0000-7000-8000-000000000001';

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe('parseMoneyToMinor', () => {
  it('parses whole and decimal major units to integer minor units', () => {
    expect(parseMoneyToMinor('150')).toBe(15000);
    expect(parseMoneyToMinor('150.5')).toBe(15050);
    expect(parseMoneyToMinor('150.50')).toBe(15050);
    expect(parseMoneyToMinor('0')).toBe(0);
    expect(parseMoneyToMinor(' 12.34 ')).toBe(1234);
    expect(parseMoneyToMinor('0.01')).toBe(1);
  });

  it('rejects anything else', () => {
    for (const bad of ['', '-1', '1,500', '1.234', '1.2.3', 'abc', '1e3', '.5', '12.']) {
      expect(parseMoneyToMinor(bad)).toBeNull();
    }
  });

  it('avoids float drift', () => {
    expect(parseMoneyToMinor('0.29')).toBe(29);
    expect(parseMoneyToMinor('19.99')).toBe(1999);
  });
});

describe('formatMinor', () => {
  it('renders minor units in major units with the currency', () => {
    expect(formatMinor(15000, 'EUR')).toBe('150.00 EUR');
    expect(formatMinor(15050, 'USD')).toBe('150.50 USD');
    expect(formatMinor(5, 'EUR')).toBe('0.05 EUR');
  });
});

describe('parsePriceFormData', () => {
  it('converts the entered major units to integer minor units', () => {
    const parsed = parsePriceFormData(
      PRODUCT_ID,
      formData({ language: 'en', currency: 'eur', unitPrice: '49.50' })
    );
    expect(parsed).toEqual({
      ok: true,
      payload: { productId: PRODUCT_ID, language: 'en', currency: 'EUR', unitPrice: 4950 },
    });
  });

  it('rejects unparseable money with a field error', () => {
    const parsed = parsePriceFormData(
      PRODUCT_ID,
      formData({ language: 'en', currency: 'EUR', unitPrice: '49,50' })
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.state.fieldErrors).toEqual({
        unitPrice: 'Enter an amount like 150 or 150.00',
      });
    }
  });

  it('passes empty language/currency through for the service schema to judge', () => {
    const parsed = parsePriceFormData(PRODUCT_ID, formData({ unitPrice: '10' }));
    expect(parsed).toEqual({
      ok: true,
      payload: { productId: PRODUCT_ID, language: '', currency: '', unitPrice: 1000 },
    });
  });
});

describe('priceStateFromError', () => {
  it('maps validation issues onto field errors', () => {
    const state = priceStateFromError({
      code: 'organization/validation',
      message: 'Price payload failed validation',
      detail: { issues: [{ path: 'currency', message: 'Must be an ISO 4217 code, e.g. EUR' }] },
    });
    expect(state.fieldErrors).toEqual({ currency: 'Must be an ISO 4217 code, e.g. EUR' });
  });

  it('pins language_not_available onto the language field', () => {
    const state = priceStateFromError({
      code: 'organization/language_not_available',
      message: "Language 'fr' is not in the product's available languages",
    });
    expect(state.fieldErrors).toEqual({
      language: "Language 'fr' is not in the product's available languages",
    });
  });

  it('falls back to the error message for other codes', () => {
    const state = priceStateFromError({
      code: 'organization/forbidden',
      message: 'Nope',
    });
    expect(state).toEqual({ status: 'error', message: 'Nope' });
  });
});
