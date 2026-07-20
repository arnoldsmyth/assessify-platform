import type { BrandingConfig, BrandingColors } from '@assessify/domain';

/**
 * Branding → CSS-variable injection (spec 11 "Branding application", spec 15
 * token structure). Overriding the Ember runtime variables re-themes every
 * component and Tailwind utility — components never see product-specific
 * styling. Pure string builder, unit-tested.
 *
 * Colour mapping (branding shape → Ember tokens):
 *   primary     → --color-primary          (actions, links, focus rings)
 *   primaryDark → --color-primary-tint-ink (text on tinted backgrounds)
 *   accent      → --color-primary-bright   (hover emphasis, progress bars)
 *   surfaceTint → --color-primary-tint     (selected rows, callouts, badges)
 *   ink         → --color-ink              (headings, dark chrome)
 */

const COLOR_VARIABLES: Record<keyof BrandingColors, string> = {
  primary: '--color-primary',
  primaryDark: '--color-primary-tint-ink',
  accent: '--color-primary-bright',
  surfaceTint: '--color-primary-tint',
  ink: '--color-ink',
};

/**
 * Values arrive Zod-validated (hex colours, http(s) URLs, bounded strings),
 * but everything here still passes a CSS-safety whitelist — this string is
 * emitted into a <style> tag, so no braces, semicolons or escapes may leak
 * out of a declaration value.
 */
function safeCssValue(value: string): string | null {
  return /^[a-zA-Z0-9 #%(),.'"/:_-]+$/.test(value) && !/[\\{};]/.test(value) ? value : null;
}

function cssUrl(url: string): string | null {
  const safe = safeCssValue(url);
  if (!safe) return null;
  return `url("${safe.replaceAll('"', '')}")`;
}

/**
 * Builds the `:root { … }` override block for a product's branding. Returns
 * an empty string when there is nothing to override (Ember defaults apply).
 */
export function brandingCssVariables(branding: BrandingConfig): string {
  const declarations: string[] = [];

  const colors = branding.colors ?? {};
  for (const [key, variable] of Object.entries(COLOR_VARIABLES) as [
    keyof BrandingColors,
    string,
  ][]) {
    const value = colors[key];
    if (!value) continue;
    const safe = safeCssValue(value);
    if (safe) declarations.push(`${variable}: ${safe};`);
  }

  if (branding.fontFamily) {
    const safe = safeCssValue(branding.fontFamily);
    // Keep the platform sans stack as the fallback tail.
    if (safe) declarations.push(`--font-sans: ${safe}, ui-sans-serif, system-ui, sans-serif;`);
  }

  if (branding.logoUrl) {
    const url = cssUrl(branding.logoUrl);
    if (url) declarations.push(`--brand-logo-url: ${url};`);
  }

  if (declarations.length === 0) return '';
  return `:root {\n  ${declarations.join('\n  ')}\n}`;
}
