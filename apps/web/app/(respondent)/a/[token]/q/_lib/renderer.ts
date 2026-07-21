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

/**
 * Display-text fallback until translation resolution (translation_strings)
 * lands: definitions carry translation string KEYS, never copy (spec 07).
 * Turns `pro-d.ws_focus.text` into `Ws focus text` — readable enough for
 * development and E2E flows; real copy arrives with the translations issue.
 */
export function labelFromKey(key: string | undefined): string {
  if (!key) return '';
  const tail = key.includes('.') ? key.slice(key.indexOf('.') + 1) : key;
  const words = tail.replace(/[._-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
