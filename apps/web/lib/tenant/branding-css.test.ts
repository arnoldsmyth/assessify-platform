import { describe, expect, it } from 'vitest';

import { brandingCssVariables } from './branding-css';

describe('brandingCssVariables', () => {
  it('returns an empty string when there is nothing to override', () => {
    expect(brandingCssVariables({})).toBe('');
    expect(brandingCssVariables({ colors: {} })).toBe('');
  });

  it('maps branding colours onto the Ember token variables', () => {
    const css = brandingCssVariables({
      colors: {
        primary: '#1d4ed8',
        primaryDark: '#1e3a8a',
        accent: '#3b82f6',
        surfaceTint: '#eff6ff',
        ink: '#0f172a',
      },
    });
    expect(css).toContain('--color-primary: #1d4ed8;');
    expect(css).toContain('--color-primary-tint-ink: #1e3a8a;');
    expect(css).toContain('--color-primary-bright: #3b82f6;');
    expect(css).toContain('--color-primary-tint: #eff6ff;');
    expect(css).toContain('--color-ink: #0f172a;');
    expect(css.startsWith(':root {')).toBe(true);
  });

  it('emits partial overrides only for the colours provided', () => {
    const css = brandingCssVariables({ colors: { primary: '#111111' } });
    expect(css).toContain('--color-primary: #111111;');
    expect(css).not.toContain('--color-ink');
  });

  it('injects font family with the platform fallback tail and the logo url', () => {
    const css = brandingCssVariables({
      fontFamily: "'Alte Haas', Georgia, serif",
      logoUrl: 'https://cdn.example.com/logo.svg',
    });
    expect(css).toContain("--font-sans: 'Alte Haas', Georgia, serif, ui-sans-serif");
    expect(css).toContain('--brand-logo-url: url("https://cdn.example.com/logo.svg");');
  });

  it('drops values that could escape a CSS declaration', () => {
    const css = brandingCssVariables({
      fontFamily: 'Nice} :root{--color-primary:red',
      colors: { primary: '#123456' },
    });
    expect(css).toContain('--color-primary: #123456;');
    expect(css).not.toContain('--font-sans');
    expect(css).not.toContain('red');
  });
});
