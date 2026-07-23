import type { ReportMergeContext, ScoreSet } from '@assessify/domain';

import { buildDimensionRows } from '../../report-service';

/**
 * Representative, fully-populated merge context for `report.html` (E5).
 *
 * Used by:
 *  - `report-template.test.ts`'s golden-file render test (the merge engine's
 *    input);
 *  - anyone previewing the template locally or seeding a PRO-D product's
 *    active report template in a dev/staging environment — see the module
 *    doc comment below for the upload path.
 *
 * Every `t.*` key and dimension key the template references is present, so
 * merging this fixture against `report.html` produces ZERO unknown
 * placeholders — a template/context drift check as much as a snapshot test.
 *
 * IDs are fixed UUIDv7-shaped literals (not `uuidv7()`) and dates are fixed
 * ISO instants so the golden HTML is byte-stable across runs (spec 09 /
 * E5: "golden files must be deterministic").
 */

const PRO_D_SCORES: ScoreSet = {
  dimensions: {
    drive: 82,
    focus: 64.5,
    resilience: 47,
    collaboration: 91,
  },
  bands: {
    drive: 'band_high',
    focus: 'band_moderate',
    resilience: 'band_low',
    collaboration: 'band_high',
  },
};

/**
 * Translation strings (B4) covering every `t.*` key `report.html` uses,
 * plus a display label for each dimension/band key `buildDimensionRows`
 * resolves through the same `strings` map (spec 08: keys are machine
 * identifiers, translated at render — see `reportMergeDimensionSchema`).
 */
const PRO_D_STRINGS: Record<string, string> = {
  cover_subtitle: 'Personal Development Report',
  cover_intro:
    'This report summarises your results across four core dimensions, based on your responses to the PRO-D questionnaire.',
  meta_respondent_label: 'Prepared for',
  meta_date_label: 'Report date',
  meta_reference_label: 'Reference',
  results_heading: 'Your Results',
  results_intro:
    'Each dimension below is scored independently. The bar shows your result relative to the other dimensions in this report.',
  notes_heading: 'About This Report',
  notes_body:
    '<p>Scores reflect self-reported responses at a single point in time and should be considered alongside other sources of feedback.</p>' +
    '<p>Discuss your results with a qualified facilitator before making significant decisions based on them.</p>',
  disclaimer: 'Confidential — for the named respondent only. Not for redistribution.',
  drive: 'Drive',
  focus: 'Focus',
  resilience: 'Resilience',
  collaboration: 'Collaboration',
  band_high: 'High',
  band_moderate: 'Moderate',
  band_low: 'Developing',
};

export const PRO_D_REPORT_FIXTURE_CONTEXT: ReportMergeContext = {
  report: {
    id: '01890000-0000-7000-8000-0000000ec001',
    kind: 'individual',
    language: 'en',
    generatedAt: '2026-07-23T09:00:00.000Z',
    generatedAtLabel: 'July 23, 2026',
    pageSize: 'a4',
  },
  order: {
    id: '01890000-0000-7000-8000-0000000ec002',
    reference: 'ORD-00042',
  },
  product: {
    name: 'PRO-D',
    slug: 'pro-d',
  },
  respondent: {
    firstName: 'Ada',
    lastName: 'Lovelace',
    fullName: 'Ada Lovelace',
  },
  session: {
    completedAt: '2026-07-22T16:45:00.000Z',
  },
  scores: PRO_D_SCORES,
  dimensions: buildDimensionRows(PRO_D_SCORES, PRO_D_STRINGS),
  t: PRO_D_STRINGS,
};
