import { describe, expect, it } from 'vitest';

import { retryLabel, summarizeErrorDetail, truncate } from './queue';

describe('summarizeErrorDetail', () => {
  it('reports missing/empty detail', () => {
    expect(summarizeErrorDetail(null)).toBe('No detail recorded');
    expect(summarizeErrorDetail({})).toBe('No detail recorded');
  });

  it('prefers the first human field and appends the code', () => {
    expect(summarizeErrorDetail({ reason: 'SMTP relay refused', attempt: 3 })).toBe(
      'SMTP relay refused'
    );
    expect(
      summarizeErrorDetail({ eventId: 'evt_2', providerRef: 'pi_1', code: 'card_declined' })
    ).toBe('[card_declined]');
    expect(summarizeErrorDetail({ message: 'Timed out', code: 'timeout' })).toBe(
      'Timed out [timeout]'
    );
  });

  it('prefers message over reason over error', () => {
    expect(summarizeErrorDetail({ error: 'c', reason: 'b', message: 'a' })).toBe('a');
    expect(summarizeErrorDetail({ error: 'c', reason: 'b' })).toBe('b');
  });

  it('falls back to compact JSON and truncates long payloads', () => {
    expect(summarizeErrorDetail({ attempt: 3 })).toBe('{"attempt":3}');
    const noisy = summarizeErrorDetail({ message: 'x'.repeat(300) });
    expect(noisy.length).toBeLessThanOrEqual(140);
    expect(noisy.endsWith('…')).toBe(true);
  });

  it('ignores non-string / blank human fields', () => {
    expect(summarizeErrorDetail({ message: '   ', code: 'boom' })).toBe('[boom]');
    expect(summarizeErrorDetail({ message: 42, code: 'boom' })).toBe('[boom]');
  });
});

describe('truncate', () => {
  it('leaves short strings alone and caps long ones with an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 10)).toBe('abcdefghij');
    expect(truncate('abcdefghijk', 10)).toBe('abcdefghi…');
  });
});

describe('retryLabel', () => {
  it('labels the three spec-06 retry events and falls back generically', () => {
    expect(retryLabel('retry_payment')).toBe('Retry payment');
    expect(retryLabel('retry_email')).toBe('Retry invitations');
    expect(retryLabel('retry_scoring')).toBe('Retry scoring');
    expect(retryLabel('something_else')).toBe('Retry');
  });
});
