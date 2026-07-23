import { reportMergeContextSchema } from '@assessify/domain';
import { describe, expect, it } from 'vitest';

import { mergeTemplate } from '../../merge';
import { PRO_D_REPORT_FIXTURE_CONTEXT } from './fixture';
import goldenHtml from './__golden__/report.merged.html?raw';
import templateHtml from './report.html?raw';

/**
 * Golden-file render test for the PRO-D report template (E5, spec 09
 * "Golden-file tests: fixture reports.data -> HTML snapshot ... per template
 * version in CI"). Runs the ACTUAL template through the ACTUAL merge engine
 * (`packages/services/src/reports/merge.ts`) against a fixture context that
 * conforms to `reportMergeContextSchema` — the same context shape
 * `report-service.ts#assembleCore` builds — and asserts the assembled HTML
 * matches the committed golden file byte-for-byte.
 *
 * The fixture (`fixture.ts`) is fully populated (fixed ids/dates, every
 * placeholder resolved) so this run has zero unknown placeholders and a
 * deterministic snapshot. To intentionally update the golden after a
 * template change, regenerate `__golden__/report.merged.html` from
 * `mergeTemplate`'s output (see the "keeping the golden in sync" note
 * below) and review the diff like any other snapshot update.
 */
describe('PRO-D report.html — golden-file merge', () => {
  it('context fixture conforms to reportMergeContextSchema', () => {
    // Same validation `assembleCore` runs before merging — catches fixture
    // drift against the real merge-context contract, not just this test.
    const parsed = reportMergeContextSchema.safeParse(PRO_D_REPORT_FIXTURE_CONTEXT);
    expect(parsed.success).toBe(true);
  });

  it('merges with zero unknown placeholders', () => {
    const result = mergeTemplate(templateHtml, PRO_D_REPORT_FIXTURE_CONTEXT);
    expect(result.unknownPlaceholders).toEqual([]);
  });

  it('matches the committed golden HTML byte-for-byte', () => {
    const result = mergeTemplate(templateHtml, PRO_D_REPORT_FIXTURE_CONTEXT);
    expect(result.html).toBe(goldenHtml);
  });

  it('is well-formed and contains the expected sections', () => {
    const { html } = mergeTemplate(templateHtml, PRO_D_REPORT_FIXTURE_CONTEXT);

    expect(html).toContain('<!doctype html>');
    expect(html).toMatch(/<html lang="en">/);
    // No placeholder syntax should survive the merge.
    expect(html).not.toMatch(/\{\{.*?\}\}/);

    // Cover section.
    expect(html).toContain('<section class="page cover">');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ORD-00042');
    expect(html).toContain('July 23, 2026');

    // Results section — one row per dimension, each with its own SVG bar.
    expect(html).toContain('<section class="page results">');
    for (const label of ['Drive', 'Focus', 'Resilience', 'Collaboration']) {
      expect(html).toContain(`<span class="dimension-name">${label}</span>`);
    }
    expect((html.match(/<svg class="dimension-bar"/g) ?? []).length).toBe(4);
    // The highest-scoring dimension (collaboration, 91) gets the full bar.
    expect(html).toContain('width="100%" height="12" rx="6" fill="#1d4ed8"');

    // Notes section, including the raw (`{{{...}}}`) narrative fragment.
    expect(html).toContain('<section class="page notes">');
    expect(html).toContain('<p>Scores reflect self-reported responses');

    // Print pagination — every page but the last breaks after itself.
    expect(html).toContain('section.page { break-after: page;');
    expect(html).toContain('section.page:last-child { break-after: auto; }');
  });
});
