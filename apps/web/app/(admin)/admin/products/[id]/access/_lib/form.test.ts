import { describe, expect, it } from 'vitest';

import { accessStateFromError } from './form';

describe('accessStateFromError', () => {
  it('maps validation issues onto field errors', () => {
    const state = accessStateFromError({
      code: 'organization/validation',
      message: 'Access payload failed validation',
      detail: { issues: [{ path: 'clientId', message: 'Invalid uuid' }] },
    });
    expect(state.fieldErrors).toEqual({ clientId: 'Invalid uuid' });
  });

  it('pins client errors onto the client field', () => {
    for (const code of [
      'organization/client_outside_organization',
      'organization/client_not_found',
    ]) {
      const state = accessStateFromError({ code, message: 'Client problem' });
      expect(state.fieldErrors).toEqual({ clientId: 'Client problem' });
    }
  });

  it('falls back to the error message for other codes', () => {
    expect(
      accessStateFromError({ code: 'organization/forbidden', message: 'Nope' })
    ).toEqual({ status: 'error', message: 'Nope' });
  });
});
