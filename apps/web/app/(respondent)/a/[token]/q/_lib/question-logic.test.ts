import { describe, expect, it } from 'vitest';

import {
  clampFreeText,
  countWords,
  freeTextCounts,
  limitWords,
  matrixCompletion,
  numericStatus,
  scalePoints,
  toggleSelection,
} from './question-logic';

describe('scalePoints', () => {
  it('builds an inclusive ascending range', () => {
    expect(scalePoints(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('supports non-1 minima (e.g. 0-based and negative scales)', () => {
    expect(scalePoints(0, 3)).toEqual([0, 1, 2, 3]);
    expect(scalePoints(-2, 2)).toEqual([-2, -1, 0, 1, 2]);
  });

  it('handles a single-point scale', () => {
    expect(scalePoints(4, 4)).toEqual([4]);
  });
});

describe('toggleSelection', () => {
  it('adds an unselected option', () => {
    expect(toggleSelection(['a'], 'b')).toEqual({ next: ['a', 'b'], blocked: false });
  });

  it('removes a selected option (never blocked, even at the limit)', () => {
    expect(toggleSelection(['a', 'b'], 'a', 2)).toEqual({ next: ['b'], blocked: false });
  });

  it('blocks adding beyond maxSelections and keeps the selection unchanged', () => {
    const result = toggleSelection(['a', 'b'], 'c', 2);
    expect(result.blocked).toBe(true);
    expect(result.next).toEqual(['a', 'b']);
  });

  it('applies no limit when maxSelections is undefined', () => {
    expect(toggleSelection(['a', 'b', 'c'], 'd').blocked).toBe(false);
  });

  it('does not mutate the input array', () => {
    const selected = ['a'];
    toggleSelection(selected, 'b');
    expect(selected).toEqual(['a']);
  });
});

describe('numericStatus', () => {
  it('accepts in-range values including the bounds', () => {
    expect(numericStatus(0, 0, 40)).toBe('ok');
    expect(numericStatus(40, 0, 40)).toBe('ok');
    expect(numericStatus(2.5, 0, 40)).toBe('ok');
  });

  it('flags out-of-range values', () => {
    expect(numericStatus(-1, 0, 40)).toBe('below_min');
    expect(numericStatus(40.5, 0, 40)).toBe('above_max');
  });

  it('flags NaN/Infinity (never emitted as answers)', () => {
    expect(numericStatus(Number.NaN, 0, 40)).toBe('not_a_number');
    expect(numericStatus(Number.POSITIVE_INFINITY, 0, 40)).toBe('not_a_number');
  });

  it('does not enforce step alignment — the server does not either', () => {
    expect(numericStatus(2.3, 0, 40)).toBe('ok'); // step 0.5 in the definition
  });
});

describe('countWords — exact mirror of answer-validation.ts wordCount', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('one two three')).toBe(3);
  });

  it('returns 0 for empty and whitespace-only strings', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
  });

  it('collapses runs of mixed whitespace like the server does', () => {
    expect(countWords('  one\n\ntwo\t three  ')).toBe(3);
  });

  it('counts punctuation-attached tokens as single words', () => {
    expect(countWords("it's a test, ok?")).toBe(4);
  });
});

describe('limitWords', () => {
  it('returns text unchanged at or under the limit', () => {
    expect(limitWords('one two', 2)).toBe('one two');
    expect(limitWords('one', 2)).toBe('one');
  });

  it('keeps trailing whitespace when still within the limit', () => {
    // "one two " is 2 words (trim) — must not be truncated mid-typing.
    expect(limitWords('one two ', 2)).toBe('one two ');
  });

  it('truncates to the end of the last allowed word', () => {
    expect(limitWords('one two three', 2)).toBe('one two');
    expect(limitWords('one  two   three four', 2)).toBe('one  two');
  });

  it('drops a partial word typed past the limit', () => {
    expect(limitWords('one two t', 2)).toBe('one two');
  });

  it('never produces a value the server would reject', () => {
    const truncated = limitWords('a b c d e f', 3);
    expect(countWords(truncated)).toBeLessThanOrEqual(3);
  });
});

describe('clampFreeText', () => {
  it('applies the character limit (UTF-16 length, same as maxLength/server)', () => {
    expect(clampFreeText('abcdef', { maxChars: 4 })).toBe('abcd');
  });

  it('applies the word limit', () => {
    expect(clampFreeText('one two three', { maxWords: 2 })).toBe('one two');
  });

  it('applies chars before words (char slice can only reduce word count)', () => {
    expect(clampFreeText('one two three', { maxChars: 7, maxWords: 2 })).toBe('one two');
    expect(clampFreeText('one two three', { maxChars: 9, maxWords: 2 })).toBe('one two');
  });

  it('is a no-op without limits', () => {
    expect(clampFreeText('anything at all', {})).toBe('anything at all');
  });
});

describe('freeTextCounts', () => {
  it('reports live counts', () => {
    const counts = freeTextCounts('one two', { maxChars: 100, maxWords: 10 });
    expect(counts).toMatchObject({ chars: 7, words: 2, atCharLimit: false, atWordLimit: false });
  });

  it('flags the char and word ceilings', () => {
    expect(freeTextCounts('abcd', { maxChars: 4 }).atCharLimit).toBe(true);
    expect(freeTextCounts('one two', { maxWords: 2 }).atWordLimit).toBe(true);
  });

  it('tracks words still needed against minWords', () => {
    expect(freeTextCounts('one two', { minWords: 10 }).wordsNeeded).toBe(8);
    expect(freeTextCounts('one two three', { minWords: 3 }).wordsNeeded).toBe(0);
    expect(freeTextCounts('one two', {}).wordsNeeded).toBe(0);
  });
});

describe('matrixCompletion', () => {
  const rows = [{ key: 'planning' }, { key: 'delegation' }, { key: 'feedback' }];

  it('reports an untouched matrix', () => {
    expect(matrixCompletion(rows, {})).toEqual({
      answeredCount: 0,
      totalCount: 3,
      complete: false,
      missingRowKeys: ['planning', 'delegation', 'feedback'],
    });
  });

  it('reports partial completion with the missing rows in definition order', () => {
    const result = matrixCompletion(rows, { delegation: 4 });
    expect(result.answeredCount).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.missingRowKeys).toEqual(['planning', 'feedback']);
  });

  it('reports a complete matrix', () => {
    const result = matrixCompletion(rows, { planning: 1, delegation: 7, feedback: 3 });
    expect(result).toMatchObject({ answeredCount: 3, complete: true, missingRowKeys: [] });
  });

  it('ignores stray keys that match no row', () => {
    const result = matrixCompletion(rows, { bogus: 2 });
    expect(result.answeredCount).toBe(0);
    expect(result.complete).toBe(false);
  });
});
