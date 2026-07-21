import { describe, expect, it } from 'vitest';

import { buildRespondentEntryUrl, resolveInvitationHost } from './invitation-link';

const CLIENT_ID = '01890a5d-ac96-774b-bcce-b302099a1111';
const OTHER_CLIENT_ID = '01890a5d-ac96-774b-bcce-b302099a2222';

describe('resolveInvitationHost (spec 11 host preference)', () => {
  const base = {
    productSlug: 'pro-d',
    slugBaseDomain: 'assessify.ie',
  };

  it('falls back to the {slug}.<base domain> subdomain with no custom domains', () => {
    expect(resolveInvitationHost({ ...base, customDomains: [], clientId: CLIENT_ID })).toBe(
      'pro-d.assessify.ie'
    );
  });

  it('prefers an active product-generic custom domain over the slug host', () => {
    expect(
      resolveInvitationHost({
        ...base,
        customDomains: [{ hostname: 'assessments.pro-d.com', clientId: null }],
        clientId: CLIENT_ID,
      })
    ).toBe('assessments.pro-d.com');
  });

  it('prefers a client-specific custom domain matching the order client', () => {
    expect(
      resolveInvitationHost({
        ...base,
        customDomains: [
          { hostname: 'assessments.pro-d.com', clientId: null },
          { hostname: 'talent.acme.com', clientId: CLIENT_ID },
        ],
        clientId: CLIENT_ID,
      })
    ).toBe('talent.acme.com');
  });

  it("ignores another client's domain and uses the generic one", () => {
    expect(
      resolveInvitationHost({
        ...base,
        customDomains: [
          { hostname: 'talent.other.com', clientId: OTHER_CLIENT_ID },
          { hostname: 'assessments.pro-d.com', clientId: null },
        ],
        clientId: CLIENT_ID,
      })
    ).toBe('assessments.pro-d.com');
  });

  it("ignores another client's domain entirely when no generic one exists", () => {
    expect(
      resolveInvitationHost({
        ...base,
        customDomains: [{ hostname: 'talent.other.com', clientId: OTHER_CLIENT_ID }],
        clientId: CLIENT_ID,
      })
    ).toBe('pro-d.assessify.ie');
  });
});

describe('buildRespondentEntryUrl (spec 05 pattern 1/2 entry URL)', () => {
  it('builds https://{host}/a/{token} with no PII', () => {
    const token = '9b2fbe45-9c17-4bd6-a0f5-2f4576a5c9b4';
    expect(buildRespondentEntryUrl('pro-d.assessify.ie', token)).toBe(
      `https://pro-d.assessify.ie/a/${token}`
    );
  });
});
