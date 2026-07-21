import { describe, expect, it } from 'vitest';

import { escapeHtml, mergeTemplate } from './merge';

describe('mergeTemplate', () => {
  it('passes HTML without placeholders through untouched, byte for byte', () => {
    const template =
      '<!doctype html>\n<html><head><style>.page{break-after:page}</style></head>' +
      '<body><h1 class="title">Static — &amp; entities, 100% raw {single braces}</h1></body></html>';
    const result = mergeTemplate(template, { anything: true });
    expect(result.html).toBe(template);
    expect(result.unknownPlaceholders).toEqual([]);
  });

  it('substitutes dot-path placeholders, HTML-escaped by default', () => {
    const result = mergeTemplate('<p>{{respondent.fullName}}</p>', {
      respondent: { fullName: 'Ada <Lovelace> & "Byron"' },
    });
    expect(result.html).toBe('<p>Ada &lt;Lovelace&gt; &amp; &quot;Byron&quot;</p>');
    expect(result.unknownPlaceholders).toEqual([]);
  });

  it('supports raw insertion with triple braces', () => {
    const result = mergeTemplate('<div>{{{fragment}}}</div>', {
      fragment: '<strong>bold</strong>',
    });
    expect(result.html).toBe('<div><strong>bold</strong></div>');
  });

  it('renders numbers and booleans with String()', () => {
    const result = mergeTemplate('{{scores.dimensions.drive}} / {{flags.done}}', {
      scores: { dimensions: { drive: 72.5 } },
      flags: { done: true },
    });
    expect(result.html).toBe('72.5 / true');
  });

  it('resolves array elements by numeric path segment', () => {
    const result = mergeTemplate('{{keys.1}}', { keys: ['a', 'b', 'c'] });
    expect(result.html).toBe('b');
  });

  it('renders unknown placeholders as empty and reports their paths once', () => {
    const result = mergeTemplate('<p>{{missing.path}} and {{missing.path}} and {{t.title}}</p>', {
      t: { title: 'Report' },
    });
    expect(result.html).toBe('<p> and  and Report</p>');
    expect(result.unknownPlaceholders).toEqual(['missing.path']);
  });

  it('treats null values and non-printable objects as unknown', () => {
    const result = mergeTemplate('{{a}}|{{b}}', { a: null, b: { nested: 1 } });
    expect(result.html).toBe('|');
    expect(result.unknownPlaceholders).toEqual(['a', 'b']);
  });

  describe('{{#each}}', () => {
    it('repeats the block per array element with {{.}} and {{@index}}', () => {
      const result = mergeTemplate(
        '<ul>{{#each keys}}<li>{{@index}}:{{.}}</li>{{/each}}</ul>',
        { keys: ['alpha', 'beta'] }
      );
      expect(result.html).toBe('<ul><li>0:alpha</li><li>1:beta</li></ul>');
      expect(result.unknownPlaceholders).toEqual([]);
    });

    it('resolves paths against the element first, then the root context', () => {
      const result = mergeTemplate(
        '{{#each rows}}[{{label}} of {{product.name}}]{{/each}}',
        { rows: [{ label: 'A' }, { label: 'B' }], product: { name: 'PRO-D' } }
      );
      expect(result.html).toBe('[A of PRO-D][B of PRO-D]');
    });

    it('supports {{.prop}} element-property access and nested loops', () => {
      const result = mergeTemplate(
        '{{#each groups}}<h2>{{.name}}</h2>{{#each .items}}<i>{{.}}</i>{{/each}}{{/each}}',
        { groups: [{ name: 'G1', items: ['x', 'y'] }, { name: 'G2', items: ['z'] }] }
      );
      expect(result.html).toBe('<h2>G1</h2><i>x</i><i>y</i><h2>G2</h2><i>z</i>');
    });

    it('renders empty and reports when the path is not an array', () => {
      const result = mergeTemplate('a{{#each nope}}X{{/each}}b', { other: 1 });
      expect(result.html).toBe('ab');
      expect(result.unknownPlaceholders).toEqual(['#each nope']);
    });

    it('escapes values inside loops', () => {
      const result = mergeTemplate('{{#each items}}{{.}}{{/each}}', { items: ['<s>'] });
      expect(result.html).toBe('&lt;s&gt;');
    });
  });
});

describe('escapeHtml', () => {
  it('escapes the five significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
  });
});
