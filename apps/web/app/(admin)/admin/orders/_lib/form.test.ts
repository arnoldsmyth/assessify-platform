import { describe, expect, it } from 'vitest';

import {
  formStateFromError,
  formatMinor,
  parseMoneyToMinor,
  parseOrderFormData,
  parseRespondentsCsv,
  transitionStateFromError,
} from './form';

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
    expect(formatMinor(-2500, 'EUR')).toBe('-25.00 EUR');
  });
});

describe('parseRespondentsCsv', () => {
  it('parses comma-separated lines with optional language', () => {
    const result = parseRespondentsCsv(
      'Ada,Lovelace,ada@example.com\nAlan,Turing,alan@example.com,fr\n'
    );
    expect(result).toEqual({
      ok: true,
      rows: [
        { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
        { firstName: 'Alan', lastName: 'Turing', email: 'alan@example.com', language: 'fr' },
      ],
    });
  });

  it('parses tab-separated lines (spreadsheet paste)', () => {
    const result = parseRespondentsCsv('Ada\tLovelace\tada@example.com\tpt-BR');
    expect(result).toEqual({
      ok: true,
      rows: [{ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', language: 'pt-BR' }],
    });
  });

  it('skips an optional header row', () => {
    const result = parseRespondentsCsv(
      'First name,Last name,Email\nAda,Lovelace,ada@example.com'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toHaveLength(1);
  });

  it('handles quoted fields with embedded commas and escaped quotes', () => {
    const result = parseRespondentsCsv('"Lovelace, Ada","O""Brien",ada@example.com');
    expect(result).toEqual({
      ok: true,
      rows: [{ firstName: 'Lovelace, Ada', lastName: 'O"Brien', email: 'ada@example.com' }],
    });
  });

  it('ignores blank lines and reports original line numbers on errors', () => {
    const result = parseRespondentsCsv(
      'Ada,Lovelace,ada@example.com\n\n,Turing,alan@example.com\nGrace,Hopper,not-an-email'
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { line: 3, message: 'First name is required' },
      { line: 4, message: '"not-an-email" is not a valid email address' },
    ]);
  });

  it('rejects wrong column counts and empty pastes', () => {
    const short = parseRespondentsCsv('Ada,ada@example.com');
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.errors[0]?.message).toContain('Expected 3 or 4 columns');

    const empty = parseRespondentsCsv('\n  \n');
    expect(empty.ok).toBe(false);

    const headerOnly = parseRespondentsCsv('First name,Last name,Email');
    expect(headerOnly.ok).toBe(false);
  });
});

function wizardFormData(overrides: Record<string, string> = {}): FormData {
  const formData = new FormData();
  const defaults: Record<string, string> = {
    type: 'named',
    clientId: '33333333-3333-7333-8333-333333333333',
    productId: '55555555-5555-7555-8555-555555555555',
    questionnaireVersionId: '66666666-6666-7666-8666-666666666666',
    reportLanguage: 'en',
    currency: 'EUR',
    unitPrice: '150.00',
    description: 'PRO-D assessment',
    respondentsJson: JSON.stringify([
      { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
    ]),
  };
  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    if (value !== '') formData.set(key, value);
  }
  return formData;
}

describe('parseOrderFormData', () => {
  it('maps structured rows to a service payload with one derived pricing line', () => {
    const result = parseOrderFormData(wizardFormData());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      type: 'named',
      clientId: '33333333-3333-7333-8333-333333333333',
      productId: '55555555-5555-7555-8555-555555555555',
      questionnaireVersionId: '66666666-6666-7666-8666-666666666666',
      reportLanguage: 'en',
      currency: 'EUR',
      items: [
        { description: 'PRO-D assessment', unitPrice: 15000, discount: 0, quantity: 1 },
      ],
      respondents: [{ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }],
      isTest: false,
    });
  });

  it('prefers raw CSV when present and derives quantity from the parsed rows', () => {
    const result = parseOrderFormData(
      wizardFormData({
        type: 'bulk_named',
        respondentsCsv: 'Ada,Lovelace,ada@example.com\nAlan,Turing,alan@example.com',
        discount: '10.00',
        isTest: 'on',
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.items).toEqual([
      { description: 'PRO-D assessment', unitPrice: 15000, discount: 1000, quantity: 2 },
    ]);
    expect(result.payload.respondents).toHaveLength(2);
    expect(result.payload.isTest).toBe(true);
  });

  it('returns line-numbered CSV errors without building a payload', () => {
    const result = parseOrderFormData(
      wizardFormData({ respondentsCsv: 'Ada,Lovelace,broken-email' })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state.csvErrors).toEqual([
      { line: 1, message: '"broken-email" is not a valid email address' },
    ]);
  });

  it('rejects unparseable money instead of guessing', () => {
    const price = parseOrderFormData(wizardFormData({ unitPrice: '1,500' }));
    expect(price.ok).toBe(false);
    if (!price.ok) expect(price.state.fieldErrors).toHaveProperty('unitPrice');

    const discount = parseOrderFormData(wizardFormData({ discount: '-5' }));
    expect(discount.ok).toBe(false);
    if (!discount.ok) expect(discount.state.fieldErrors).toHaveProperty('discount');
  });

  it('rejects malformed respondentsJson', () => {
    for (const bad of ['not json', '{"a":1}', '[{"firstName":1}]']) {
      const result = parseOrderFormData(wizardFormData({ respondentsJson: bad }));
      expect(result.ok).toBe(false);
    }
  });
});

describe('error → form-state mapping', () => {
  it('maps order/validation issues to fieldErrors', () => {
    const state = formStateFromError({
      code: 'order/validation',
      message: 'Order payload failed validation',
      detail: {
        issues: [
          { path: 'respondents.1.email', message: 'Must be a valid email address' },
          { path: 'respondents.1.email', message: 'duplicate — ignored' },
        ],
      },
    });
    expect(state.status).toBe('error');
    expect(state.fieldErrors).toEqual({
      'respondents.1.email': 'Must be a valid email address',
    });
  });

  it('maps illegal transitions with their legal events', () => {
    const state = transitionStateFromError({
      code: 'order/illegal_transition',
      message: 'Event "submit" is not allowed while the order is "completed"',
      detail: { from: 'completed', event: 'submit', legalEvents: ['refund', 'hold'] },
    });
    expect(state.status).toBe('error');
    expect(state.legalEvents).toEqual(['refund', 'hold']);
  });

  it('falls back to the error message for other codes', () => {
    const state = formStateFromError({ code: 'order/forbidden', message: 'Nope' });
    expect(state).toEqual({ status: 'error', message: 'Nope' });
  });
});
