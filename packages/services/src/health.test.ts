import { describe, expect, it } from 'vitest';
import { getHealth } from './health';

describe('getHealth', () => {
  it('returns an ok result', () => {
    const result = getHealth();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('ok');
    }
  });
});
