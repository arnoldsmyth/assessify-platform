/**
 * Dependency-free template merge engine for uploaded HTML report templates
 * (E3 — spec 09 re-scoped 2026-07-21). Templates are pixel-perfect,
 * hand-built HTML documents; the engine only substitutes placeholders and
 * expands loops — everything else passes through byte-for-byte.
 *
 * # Placeholder syntax
 *
 * - `{{path.to.value}}` — dot-path lookup into the merge context, inserted
 *   **HTML-escaped**. Array elements by numeric segment: `{{scores.narrativeKeys.0}}`.
 * - `{{{path.to.value}}}` — same lookup, inserted raw (unescaped). Only for
 *   context values that are themselves trusted HTML fragments.
 * - `{{#each path.to.array}} … {{/each}}` — repeats the enclosed block once
 *   per array element. Inside the block:
 *     - `{{.}}` is the current element, `{{.prop}}` a property of it;
 *     - `{{@index}}` is the zero-based index;
 *     - any other path resolves against the current element FIRST, then
 *       falls back to the root context. Blocks nest.
 *
 * Values render with `String(value)`; `null`/`undefined`/missing paths (and
 * `{{#each}}` over non-arrays) render as EMPTY STRING and are reported in
 * `unknownPlaceholders` so callers can surface template/data drift (the
 * report still assembles — spec 09 treats template bugs as authoring
 * concerns, not runtime failures).
 *
 * No conditionals, no helpers, no expressions — by design. Anything smarter
 * belongs in the merge-context builder, where it is testable and versioned.
 */

export interface MergeResult {
  html: string;
  /**
   * Placeholder paths that resolved to nothing (deduplicated, in first-seen
   * order). `#each` misses are reported as `#each <path>`.
   */
  unknownPlaceholders: string[];
}

const EACH_OPEN = /\{\{#each\s+([^{}]+?)\s*\}\}/;
const EACH_CLOSE = '{{/each}}';
/** `{{{raw}}}` first so the triple form never half-matches as `{{ {raw} }}`. */
const PLACEHOLDER = /\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([^{}#/][^{}]*?)\s*\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Dot-path lookup; `undefined` means "not resolvable". */
function lookupPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (segment === '') continue;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

interface Scope {
  root: unknown;
  /** Innermost-first `#each` frames: [element, index]. */
  frames: { element: unknown; index: number }[];
}

/** Resolve one placeholder path within the current scope. */
function resolve(scope: Scope, path: string): unknown {
  const frame = scope.frames[0];
  if (frame) {
    if (path === '.') return frame.element;
    if (path === '@index') return frame.index;
    if (path.startsWith('.')) return lookupPath(frame.element, path.slice(1));
    // Bare paths: current element first, then outer frames, then the root.
    for (const candidate of scope.frames) {
      const fromFrame = lookupPath(candidate.element, path);
      if (fromFrame !== undefined) return fromFrame;
    }
  }
  return lookupPath(scope.root, path);
}

function renderValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects/arrays are not directly printable — treat as unresolved rather
  // than leaking `[object Object]` into a report.
  return undefined;
}

/**
 * Find the block enclosed by the FIRST `{{#each}}` in `input`, honouring
 * nesting. Returns null when there is no `#each` (or it is unterminated —
 * an unterminated block passes through literally, reported by the caller).
 */
function findEachBlock(
  input: string
): { start: number; end: number; path: string; body: string } | null {
  const open = EACH_OPEN.exec(input);
  if (!open || open.index === undefined) return null;
  const bodyStart = open.index + open[0].length;
  let depth = 1;
  let cursor = bodyStart;
  for (;;) {
    const nextOpen = EACH_OPEN.exec(input.slice(cursor));
    const nextClose = input.indexOf(EACH_CLOSE, cursor);
    if (nextClose === -1) return null; // unterminated
    const nextOpenAt = nextOpen ? cursor + nextOpen.index : -1;
    if (nextOpenAt !== -1 && nextOpenAt < nextClose) {
      depth += 1;
      cursor = nextOpenAt + nextOpen![0].length;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return {
        start: open.index,
        end: nextClose + EACH_CLOSE.length,
        path: (open[1] ?? '').trim(),
        body: input.slice(bodyStart, nextClose),
      };
    }
    cursor = nextClose + EACH_CLOSE.length;
  }
}

function mergePart(input: string, scope: Scope, unknown: Set<string>): string {
  let output = '';
  let rest = input;

  for (;;) {
    const block = findEachBlock(rest);
    if (!block) {
      output += substitute(rest, scope, unknown);
      return output;
    }
    output += substitute(rest.slice(0, block.start), scope, unknown);
    const value = resolve(scope, block.path);
    if (Array.isArray(value)) {
      value.forEach((element, index) => {
        output += mergePart(block.body, {
          root: scope.root,
          frames: [{ element, index }, ...scope.frames],
        }, unknown);
      });
    } else {
      unknown.add(`#each ${block.path}`);
    }
    rest = rest.slice(block.end);
  }
}

function substitute(input: string, scope: Scope, unknown: Set<string>): string {
  return input.replace(PLACEHOLDER, (_match, rawPath: string | undefined, escapedPath: string | undefined) => {
    const path = (rawPath ?? escapedPath ?? '').trim();
    if (path === '') return '';
    const rendered = renderValue(resolve(scope, path));
    if (rendered === undefined) {
      unknown.add(path);
      return '';
    }
    return rawPath !== undefined ? rendered : escapeHtml(rendered);
  });
}

/**
 * Merge a template against a context. Never throws on template/data drift —
 * unresolved placeholders render empty and are reported.
 */
export function mergeTemplate(template: string, context: unknown): MergeResult {
  const unknown = new Set<string>();
  const html = mergePart(template, { root: context, frames: [] }, unknown);
  return { html, unknownPlaceholders: [...unknown] };
}
