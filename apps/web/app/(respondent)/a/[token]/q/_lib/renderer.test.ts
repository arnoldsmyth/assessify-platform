import { afterEach, describe, expect, it } from 'vitest';

import { humanizeKey, labelFromKey, setTranslationStrings } from './renderer';

/**
 * Label resolution (asy-sex). The strings context is module-level state, so
 * every test resets it.
 */

afterEach(() => setTranslationStrings({}));

describe('labelFromKey', () => {
  it('resolves a key through the registered server strings', () => {
    setTranslationStrings({ 'pro-d.ws_focus.text': 'Where do you focus at work?' });
    expect(labelFromKey('pro-d.ws_focus.text')).toBe('Where do you focus at work?');
  });

  it('humanizes keys with no resolved string (missing-translation fallback)', () => {
    setTranslationStrings({ other: 'x' });
    expect(labelFromKey('pro-d.ws_focus.text')).toBe('Ws focus text');
  });

  it('keeps the pre-translation behaviour when no strings are registered', () => {
    expect(labelFromKey('pro-d.ws_focus.text')).toBe('Ws focus text');
    expect(labelFromKey('plain')).toBe('Plain');
    expect(labelFromKey(undefined)).toBe('');
    expect(labelFromKey('')).toBe('');
  });

  it('re-registering strings replaces the previous set (language switch refresh)', () => {
    setTranslationStrings({ k: 'English copy' });
    expect(labelFromKey('k')).toBe('English copy');
    setTranslationStrings({ k: 'Copie française' });
    expect(labelFromKey('k')).toBe('Copie française');
    setTranslationStrings({});
    expect(labelFromKey('k')).toBe('K');
  });
});

describe('humanizeKey', () => {
  it('drops the namespace and title-cases the tail', () => {
    expect(humanizeKey('pro-d.section_one.title')).toBe('Section one title');
    expect(humanizeKey('no-namespace')).toBe('No namespace');
  });
});
