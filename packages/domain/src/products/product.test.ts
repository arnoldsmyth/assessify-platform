import { describe, expect, it } from 'vitest';

import { scoringConfigSchema } from './product';

/**
 * `scoring_config` schema — E2 Pro-Logic extension. Backward compatibility
 * matters here: every config shape E1 accepted must still parse.
 */
describe('scoringConfigSchema', () => {
  it('still accepts the E1 shapes (sync_internal, async_external + endpoint)', () => {
    expect(scoringConfigSchema.safeParse({ mode: 'sync_internal' }).success).toBe(true);
    expect(
      scoringConfigSchema.safeParse({
        mode: 'async_external',
        retrieval: 'pull',
        endpoint: 'https://engine.example/api',
      }).success
    ).toBe(true);
  });

  it('accepts a full prologic config without an endpoint (base URL comes from env)', () => {
    const parsed = scoringConfigSchema.safeParse({
      mode: 'async_external',
      provider: 'prologic',
      accessCode: 'ac_test123',
      scopes: ['mcs', 'insights'],
      toolMap: { person: { q1: 1, q2: 2 }, role: { q3: 1 } },
      norms: 'pooled',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.provider).toBe('prologic');
    expect(parsed.data.accessCode).toBe('ac_test123');
  });

  it('requires accessCode, scopes and toolMap for prologic', () => {
    const parsed = scoringConfigSchema.safeParse({
      mode: 'async_external',
      provider: 'prologic',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const paths = parsed.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['accessCode', 'scopes', 'toolMap']));
  });

  it('rejects a provider on non-async modes and unknown scopes/tools', () => {
    expect(
      scoringConfigSchema.safeParse({ mode: 'sync_internal', provider: 'prologic' }).success
    ).toBe(false);
    expect(
      scoringConfigSchema.safeParse({
        mode: 'async_external',
        provider: 'prologic',
        accessCode: 'ac_x',
        scopes: ['not-a-scope'],
        toolMap: { person: { q1: 1 } },
      }).success
    ).toBe(false);
    expect(
      scoringConfigSchema.safeParse({
        mode: 'async_external',
        provider: 'prologic',
        accessCode: 'ac_x',
        scopes: ['mcs'],
        toolMap: { 'not-a-tool': { q1: 1 } },
      }).success
    ).toBe(false);
  });

  it('rejects a toolMap where two question keys collide on one q', () => {
    const parsed = scoringConfigSchema.safeParse({
      mode: 'async_external',
      provider: 'prologic',
      accessCode: 'ac_x',
      scopes: ['mcs'],
      toolMap: { person: { q1: 1, q2: 1 } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => /already mapped/.test(issue.message))).toBe(true);
  });

  it('rejects 0-based q values (the Pro-Logic contract is 1-based)', () => {
    expect(
      scoringConfigSchema.safeParse({
        mode: 'async_external',
        provider: 'prologic',
        accessCode: 'ac_x',
        scopes: ['mcs'],
        toolMap: { person: { q1: 0 } },
      }).success
    ).toBe(false);
  });

  it('still requires an endpoint for provider-less async_external configs', () => {
    expect(scoringConfigSchema.safeParse({ mode: 'async_external' }).success).toBe(false);
  });
});
