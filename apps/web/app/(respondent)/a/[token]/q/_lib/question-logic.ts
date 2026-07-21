/**
 * Pure per-question-type logic for the C3 question components (spec 07).
 *
 * Everything here is framework-free so it can be unit-tested with vitest
 * (`apps/web` has no DOM test framework by design). The validation mirrors
 * are exactly that — mirrors of the authoritative server rules in
 * `packages/services/src/questionnaire-session/answer-validation.ts` — kept
 * behaviourally identical so the client never emits an answer the server's
 * `saveIssues` would reject (a rejected record fails the WHOLE autosave
 * patch, surfacing a retry banner).
 */

// ---------------------------------------------------------------------------
// Scales (likert + matrix)
// ---------------------------------------------------------------------------

/** Inclusive integer points of a likert/matrix scale, ascending. */
export function scalePoints(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

// ---------------------------------------------------------------------------
// Multiple choice (multi) selection toggling
// ---------------------------------------------------------------------------

export interface ToggleResult {
  next: string[];
  /** True when adding was refused because `maxSelections` is already reached. */
  blocked: boolean;
}

/**
 * Toggle an option in a multi-select answer. Deselecting is always allowed;
 * selecting past `maxSelections` is blocked (server `saveIssues` rejects
 * `too_many_selections`, so the client must never emit it).
 */
export function toggleSelection(
  selected: readonly string[],
  optionKey: string,
  maxSelections?: number
): ToggleResult {
  if (selected.includes(optionKey)) {
    return { next: selected.filter((key) => key !== optionKey), blocked: false };
  }
  if (maxSelections !== undefined && selected.length >= maxSelections) {
    return { next: [...selected], blocked: true };
  }
  return { next: [...selected, optionKey], blocked: false };
}

// ---------------------------------------------------------------------------
// Numeric
// ---------------------------------------------------------------------------

export type NumericStatus = 'ok' | 'below_min' | 'above_max' | 'not_a_number';

/**
 * Mirror of the server's numeric `saveIssues` check (`value_out_of_range`):
 * only the min/max bounds are validated — the server does not enforce `step`
 * alignment, so neither do we (the input's `step` attribute is a UX hint).
 */
export function numericStatus(value: number, min: number, max: number): NumericStatus {
  if (!Number.isFinite(value)) return 'not_a_number';
  if (value < min) return 'below_min';
  if (value > max) return 'above_max';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Free text — counting mirrors answer-validation.ts EXACTLY
// ---------------------------------------------------------------------------

/**
 * Word counting — byte-for-byte the same rule as the server's `wordCount`
 * (trim, then split on runs of whitespace; empty string is 0 words).
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Truncate `text` so it contains at most `maxWords` words, cutting at the end
 * of the last allowed word (drops any trailing whitespace/partial word). Used
 * to PREVENT over-limit values ever reaching autosave — the server rejects
 * `too_many_words` outright rather than truncating.
 */
export function limitWords(text: string, maxWords: number): string {
  if (countWords(text) <= maxWords) return text;
  const wordPattern = /\S+/g;
  let seen = 0;
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = wordPattern.exec(text)) !== null) {
    seen += 1;
    end = match.index + match[0].length;
    if (seen === maxWords) break;
  }
  return text.slice(0, end);
}

/**
 * Enforce both free-text limits on a candidate value (typed OR pasted).
 * Characters first (UTF-16 length, same as the server's `value.length` and
 * the DOM `maxLength` attribute), then words — char-slicing can only reduce
 * the word count, so the order is safe.
 */
export function clampFreeText(
  text: string,
  limits: { maxChars?: number; maxWords?: number }
): string {
  let next = text;
  if (limits.maxChars !== undefined && next.length > limits.maxChars) {
    next = next.slice(0, limits.maxChars);
  }
  if (limits.maxWords !== undefined) {
    next = limitWords(next, limits.maxWords);
  }
  return next;
}

export interface FreeTextCounts {
  chars: number;
  words: number;
  /** True when the char count is at the maxChars ceiling. */
  atCharLimit: boolean;
  /** True when the word count is at the maxWords ceiling. */
  atWordLimit: boolean;
  /** Words still needed to reach minWords (0 when satisfied or no minimum). */
  wordsNeeded: number;
}

/** Live counter state for the free-text component. */
export function freeTextCounts(
  text: string,
  limits: { maxChars?: number; maxWords?: number; minWords?: number }
): FreeTextCounts {
  const chars = text.length;
  const words = countWords(text);
  return {
    chars,
    words,
    atCharLimit: limits.maxChars !== undefined && chars >= limits.maxChars,
    atWordLimit: limits.maxWords !== undefined && words >= limits.maxWords,
    wordsNeeded: limits.minWords !== undefined ? Math.max(0, limits.minWords - words) : 0,
  };
}

// ---------------------------------------------------------------------------
// Ranking (C4)
// ---------------------------------------------------------------------------

/**
 * True when `candidate` is a full permutation of `keys` — same length, no
 * duplicates, every entry known. Mirrors the server's
 * `not_a_permutation_of_options` check in answer-validation.ts exactly: the
 * component must never emit anything else, because a partial or corrupt order
 * fails the whole autosave patch.
 */
export function isPermutationOf(candidate: readonly string[], keys: readonly string[]): boolean {
  if (candidate.length !== keys.length) return false;
  if (new Set(candidate).size !== candidate.length) return false;
  const known = new Set(keys);
  return candidate.every((key) => known.has(key));
}

/**
 * Working order for the ranking component: the saved answer when it is a
 * valid permutation of the current option keys, otherwise the definition
 * order. A saved order can only be invalid if the definition changed under a
 * pinned session (should not happen — versions are immutable) or the record
 * was corrupted; falling back to definition order is the safe recovery.
 */
export function normalizeRankingOrder(
  optionKeys: readonly string[],
  saved: readonly string[] | undefined
): string[] {
  if (saved !== undefined && isPermutationOf(saved, optionKeys)) return [...saved];
  return [...optionKeys];
}

export interface RankingMove {
  next: string[];
  /** False when the move was a no-op (already at the boundary / bad index). */
  moved: boolean;
  /** 0-based index the item ended up at (=== from when not moved). */
  to: number;
}

/**
 * Move the item at `index` by `delta` positions (usually ±1 for the up/down
 * buttons). Boundary and out-of-range moves are no-ops so callers can wire
 * buttons without pre-checking. Never mutates the input.
 */
export function moveItem(order: readonly string[], index: number, delta: number): RankingMove {
  const item = order[index];
  const to = index + delta;
  if (item === undefined || to < 0 || to >= order.length || delta === 0) {
    return { next: [...order], moved: false, to: index };
  }
  const next = [...order];
  next.splice(index, 1);
  next.splice(to, 0, item);
  return { next, moved: true, to };
}

// ---------------------------------------------------------------------------
// Ipsative most/least (C4)
// ---------------------------------------------------------------------------

/** Partial most/least pair while the respondent is building the answer. */
export interface IpsativePair {
  most: string | null;
  least: string | null;
}

export interface IpsativeChoice {
  next: IpsativePair;
  /**
   * Column that was auto-cleared by the same-row conflict rule (spec 07:
   * choosing Most on the row that currently holds Least clears Least, and
   * vice versa — never both on one row, never a silently invalid pair).
   */
  cleared: 'most' | 'least' | null;
  /** True when the pair is now complete (both chosen, provably different). */
  complete: boolean;
}

/**
 * Apply one radio selection to the pair. The returned pair is always valid
 * (most !== least when both set), so a `complete` result can be stamped
 * straight into the domain's ipsative record, whose Zod refine rejects
 * most === least.
 */
export function chooseIpsative(
  pair: IpsativePair,
  column: 'most' | 'least',
  itemKey: string
): IpsativeChoice {
  let { most, least } = pair;
  let cleared: IpsativeChoice['cleared'] = null;
  if (column === 'most') {
    most = itemKey;
    if (least === itemKey) {
      least = null;
      cleared = 'least';
    }
  } else {
    least = itemKey;
    if (most === itemKey) {
      most = null;
      cleared = 'most';
    }
  }
  return { next: { most, least }, cleared, complete: most !== null && least !== null };
}

export type IpsativeStatus = 'empty' | 'need_most' | 'need_least' | 'complete';

/** Completion state driving the ipsative hint/status copy (spec 07 mandates
 * distinct messages for missing Most vs missing Least). */
export function ipsativeStatus(pair: IpsativePair): IpsativeStatus {
  if (pair.most !== null && pair.least !== null) return 'complete';
  if (pair.most !== null) return 'need_least';
  if (pair.least !== null) return 'need_most';
  return 'empty';
}

// ---------------------------------------------------------------------------
// Matrix completion
// ---------------------------------------------------------------------------

export interface MatrixCompletion {
  answeredCount: number;
  totalCount: number;
  complete: boolean;
  missingRowKeys: string[];
}

/**
 * Per-row completion for a matrix answer (`{ [rowKey]: number }`). Only keys
 * matching real rows count — stray keys are the server's concern
 * (`unknown_row`) and cannot be produced by the component.
 */
export function matrixCompletion(
  rows: readonly { key: string }[],
  value: Readonly<Record<string, number>>
): MatrixCompletion {
  const missingRowKeys = rows.filter((row) => value[row.key] === undefined).map((row) => row.key);
  const answeredCount = rows.length - missingRowKeys.length;
  return {
    answeredCount,
    totalCount: rows.length,
    complete: missingRowKeys.length === 0,
    missingRowKeys,
  };
}
