import { describe, expect, it } from 'vitest';

import {
  completionNotificationPolicySchema,
  DEFAULT_COMPLETION_NOTIFICATION_POLICY,
  resolveCompletionNotificationPolicy,
  type CompletionNotificationPolicy,
} from './notifications';

/**
 * Completion notification policy (E6 — spec 13): schema boundaries and the
 * order > client > product > default precedence, exhaustively.
 */

const respondentOnly: CompletionNotificationPolicy = {
  recipients: [{ type: 'respondent', includeReportLink: true }],
};
const clientOnly: CompletionNotificationPolicy = {
  recipients: [{ type: 'client', includeReportLink: false }],
};
const thirdPartyOnly: CompletionNotificationPolicy = {
  recipients: [{ type: 'third_party', emails: ['hr@client.example'], includeReportLink: false }],
};
const silence: CompletionNotificationPolicy = { recipients: [] };

/** Wrap a policy the way it rides the jsonb columns (under `completion`). */
function layer(policy: unknown): Record<string, unknown> {
  return { completion: policy };
}

describe('completionNotificationPolicySchema', () => {
  it('accepts the spec-13 shape and defaults includeReportLink to false', () => {
    const parsed = completionNotificationPolicySchema.parse({
      recipients: [
        { type: 'respondent' },
        { type: 'client', emails: ['admin@client.example'] },
        { type: 'third_party', emails: ['hr@client.example'], includeReportLink: true },
      ],
    });
    expect(parsed.recipients[0]).toEqual({ type: 'respondent', includeReportLink: false });
    expect(parsed.recipients[1]?.emails).toEqual(['admin@client.example']);
  });

  it('accepts an empty recipients list (explicit silence)', () => {
    expect(completionNotificationPolicySchema.parse({ recipients: [] }).recipients).toEqual([]);
  });

  it('requires at least one email for third_party recipients', () => {
    expect(
      completionNotificationPolicySchema.safeParse({ recipients: [{ type: 'third_party' }] })
        .success
    ).toBe(false);
    expect(
      completionNotificationPolicySchema.safeParse({
        recipients: [{ type: 'third_party', emails: [] }],
      }).success
    ).toBe(false);
  });

  it('rejects invalid emails, unknown recipient types, and unknown keys', () => {
    expect(
      completionNotificationPolicySchema.safeParse({
        recipients: [{ type: 'client', emails: ['not-an-email'] }],
      }).success
    ).toBe(false);
    expect(
      completionNotificationPolicySchema.safeParse({ recipients: [{ type: 'everyone' }] }).success
    ).toBe(false);
    expect(
      completionNotificationPolicySchema.safeParse({ recipients: [], extra: true }).success
    ).toBe(false);
    expect(
      completionNotificationPolicySchema.safeParse({
        recipients: [{ type: 'client', sendPdf: true }],
      }).success
    ).toBe(false);
  });
});

describe('resolveCompletionNotificationPolicy', () => {
  it('order override wins over client and product layers', () => {
    const resolved = resolveCompletionNotificationPolicy(
      layer(silence),
      layer(clientOnly),
      layer(respondentOnly)
    );
    expect(resolved).toEqual({ policy: silence, source: 'order' });
  });

  it('client override wins over the product default', () => {
    const resolved = resolveCompletionNotificationPolicy(
      null,
      layer(thirdPartyOnly),
      layer(respondentOnly)
    );
    expect(resolved).toEqual({ policy: thirdPartyOnly, source: 'client' });
  });

  it('client override wins when the order layer has no completion key', () => {
    const resolved = resolveCompletionNotificationPolicy(
      { reportRelease: 'auto' },
      layer(clientOnly),
      null
    );
    expect(resolved).toEqual({ policy: clientOnly, source: 'client' });
  });

  it('falls back to the product default when order and client are silent', () => {
    const resolved = resolveCompletionNotificationPolicy(null, null, layer(clientOnly));
    expect(resolved).toEqual({ policy: clientOnly, source: 'product' });
  });

  it('falls back to the platform default when no layer configures completion', () => {
    const resolved = resolveCompletionNotificationPolicy(null, null, null);
    expect(resolved).toEqual({
      policy: DEFAULT_COMPLETION_NOTIFICATION_POLICY,
      source: 'default',
    });
    expect(resolved.policy.recipients).toEqual([
      { type: 'respondent', includeReportLink: true },
    ]);
  });

  it('falls back when the jsonb columns exist but carry no completion key', () => {
    const resolved = resolveCompletionNotificationPolicy({}, {}, { reportRelease: 'manual' });
    expect(resolved.source).toBe('default');
  });

  it('skips a malformed layer instead of failing (order → client fallback)', () => {
    const resolved = resolveCompletionNotificationPolicy(
      layer({ recipients: [{ type: 'nonsense' }] }),
      layer(clientOnly),
      layer(respondentOnly)
    );
    expect(resolved).toEqual({ policy: clientOnly, source: 'client' });
  });

  it('skips malformed layers all the way down to the default', () => {
    const resolved = resolveCompletionNotificationPolicy(
      layer('auto'),
      layer({ recipients: 'all' }),
      layer(42)
    );
    expect(resolved).toEqual({
      policy: DEFAULT_COMPLETION_NOTIFICATION_POLICY,
      source: 'default',
    });
  });

  it('an explicit empty-recipients order override silences lower layers', () => {
    const resolved = resolveCompletionNotificationPolicy(layer(silence), null, layer(clientOnly));
    expect(resolved).toEqual({ policy: silence, source: 'order' });
  });
});
