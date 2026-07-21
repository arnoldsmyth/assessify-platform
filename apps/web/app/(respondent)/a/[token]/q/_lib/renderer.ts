import type { RendererState } from '@assessify/services';

/**
 * Client-safe helpers + type aliases for the questionnaire renderer (C2).
 *
 * Types are derived from the service's `RendererState`; the only direct
 * dependency on @assessify/questionnaire-schema is the pure `showIf`
 * evaluator shared with the server (C5, see visibility.ts) — spec 07 requires
 * renderer and validator to share that function.
 */

export type Definition = RendererState['definition'];
export type Section = Definition['sections'][number];
export type Question = Section['questions'][number];

// ---------------------------------------------------------------------------
// Translation string resolution (asy-sex)
// ---------------------------------------------------------------------------

/**
 * Module-level strings context for `labelFromKey` (asy-sex): the renderer
 * registers the server-resolved `RendererState.strings` map once per render
 * pass, and every existing `labelFromKey(key)` call-site — including the
 * per-type question components, which stay untouched — resolves through it.
 * One questionnaire renders per page, so a module singleton is safe; the
 * registration happens synchronously at the top of the renderer's render,
 * before any child reads a label.
 */
let activeStrings: Record<string, string> = {};

/** Register the server-resolved strings for this render pass. */
export function setTranslationStrings(strings: Record<string, string>): void {
  activeStrings = strings;
}

/**
 * Resolve a translation key to display copy: the server-resolved string when
 * present (requested language with default-language fallback — B4), else a
 * humanized form of the key itself. The humanize fallback keeps untranslated
 * keys readable in development and for partially translated products —
 * `pro-d.ws_focus.text` renders as `Ws focus text`.
 */
export function labelFromKey(key: string | undefined): string {
  if (!key) return '';
  const resolved = activeStrings[key];
  if (resolved !== undefined) return resolved;
  return humanizeKey(key);
}

/** The pre-translation display fallback: `pro-d.ws_focus.text` → `Ws focus text`. */
export function humanizeKey(key: string): string {
  const tail = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
  const words = tail.replace(/[._-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
