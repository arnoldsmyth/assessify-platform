import { z } from 'zod';

import { reportPageSizeSchema } from '../products/product';
import { scoreSetSchema } from '../scoring';

/**
 * Report domain types (docs/spec/09-reports-and-pdf.md, re-scoped per owner
 * decision 2026-07-21): report templates are manually built, pixel-perfect
 * HTML documents per product, UPLOADED to object storage — not React
 * components generated from branding tokens. A `report_template_versions`
 * row references the stored bytes through its `config` jsonb (the table's
 * `component_key` column predates the re-scope; uploaded templates all carry
 * the sentinel key below — see the schema-mismatch note on
 * `reportTemplateConfigSchema`).
 *
 * Assembly = fetch template from storage + merge score/respondent/product
 * data + serve. Some products are web-only (no PDF), so every template
 * declares web/pdf availability flags.
 */

// ---------------------------------------------------------------------------
// Template versions (`report_template_versions` — spec 04 catalogue)
// ---------------------------------------------------------------------------

/** Same lifecycle conventions as questionnaire versions (B3 / spec 07). */
export const reportTemplateStatuses = ['draft', 'active', 'retired'] as const;
export const reportTemplateStatusSchema = z.enum(reportTemplateStatuses);
export type ReportTemplateStatus = z.infer<typeof reportTemplateStatusSchema>;

/**
 * `component_key` sentinel for uploaded-HTML templates. The column was
 * designed to map to a React component in code (pre-re-scope); uploaded
 * templates have no component, so they all share this marker.
 */
export const UPLOADED_HTML_COMPONENT_KEY = 'uploaded_html';

/**
 * Which render modes a template supports. Web-only products upload templates
 * with `pdf: false`; the "Download PDF" affordance and the PdfRenderer path
 * are disabled for them. At least one mode must be available.
 */
export const reportTemplateCapabilitiesSchema = z
  .object({
    web: z.boolean().default(true),
    pdf: z.boolean().default(false),
  })
  .refine((caps) => caps.web || caps.pdf, {
    message: 'A template must support at least one of web or pdf',
  });
export type ReportTemplateCapabilities = z.infer<typeof reportTemplateCapabilitiesSchema>;

/**
 * The validated shape of `report_template_versions.config` for uploaded-HTML
 * templates.
 *
 * SCHEMA MISMATCH (flagged, deliberate): the table still carries the
 * pre-re-scope `component_key` + `config` columns for React templates. Until
 * a migration lands, uploaded templates store everything they need inside
 * `config`: the object-storage key of the HTML bytes and the web/pdf
 * capability flags. `component_key` is always `UPLOADED_HTML_COMPONENT_KEY`.
 */
export const reportTemplateConfigSchema = z.object({
  /**
   * Object-storage key of the template HTML —
   * `templates/{productId}/{templateVersionId}.html` (never contains PII).
   */
  storageKey: z.string().min(1),
  contentType: z.literal('text/html').default('text/html'),
  capabilities: reportTemplateCapabilitiesSchema,
});
export type ReportTemplateConfig = z.infer<typeof reportTemplateConfigSchema>;

// ---------------------------------------------------------------------------
// Reports (`reports` table — spec 04 / spec 09)
// ---------------------------------------------------------------------------

export const reportStatuses = ['pending', 'ready', 'released'] as const;
export const reportStatusSchema = z.enum(reportStatuses);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

export const reportKinds = ['individual', 'aggregate'] as const;
export const reportKindSchema = z.enum(reportKinds);
export type ReportKind = z.infer<typeof reportKindSchema>;

// ---------------------------------------------------------------------------
// Release policy (spec 09: "if the product/client policy is auto-release →
// released, else a client/admin releases manually")
// ---------------------------------------------------------------------------

export const reportReleasePolicies = ['auto', 'manual'] as const;
export const reportReleasePolicySchema = z.enum(reportReleasePolicies);
export type ReportReleasePolicy = z.infer<typeof reportReleasePolicySchema>;

/**
 * Resolve the release policy for one order. Spec 09 names "product/client
 * policy" without a dedicated column; pending one, the policy rides the
 * existing jsonb configs under the `reportRelease` key with order-override
 * precedence (mirroring the spec-13 notification-policy precedence):
 *
 *   `orders.notification_policy.reportRelease`
 *     → `products.notification_defaults.reportRelease`
 *       → `'manual'` (held — the safe default).
 *
 * A client-level override (`clients.notification_overrides.reportRelease`)
 * belongs between the two once the client repository exposes it.
 */
export function resolveReportReleasePolicy(
  orderPolicy: Record<string, unknown> | null,
  productDefaults: Record<string, unknown>
): ReportReleasePolicy {
  for (const source of [orderPolicy, productDefaults]) {
    const parsed = reportReleasePolicySchema.safeParse(source?.['reportRelease']);
    if (parsed.success) return parsed.data;
  }
  return 'manual';
}

// ---------------------------------------------------------------------------
// Merge context — the data a template's placeholders can reference
// ---------------------------------------------------------------------------

/**
 * One dimension's report-ready row, derived from the ScoreSet by the
 * assembly service (`report-service.ts`) before the merge context is built.
 * This is NOT part of `ScoreSet` itself (`packages/domain/src/scoring.ts`) —
 * `scores.dimensions` there is a `Record<string, number>` (spec 08), and the
 * merge engine's `{{#each}}` only expands arrays (`packages/services/src/
 * reports/merge.ts`), so a template cannot loop the record directly.
 *
 * `dimensions` is therefore an assessment-agnostic flattening added to the
 * merge context (E5, docs/spec/09-reports-and-pdf.md): value formatting, the
 * `scores.bands[key]` -> `t[bandKey]` label lookup already implied by spec 08
 * ("band label KEY, resolved via translations at render"), and a relative
 * bar width for a server-rendered SVG dimension chart. `ScoreSet` carries no
 * fixed min/max, so `barPercent` is scaled against the highest-scoring
 * dimension IN THIS report rather than assuming any particular scale (e.g.
 * 0-100) — this stays generic across scoring engines and products.
 */
export const reportMergeDimensionSchema = z
  .object({
    key: z.string().min(1),
    /**
     * Display name for the dimension. `scoreKeySchema` (spec 08) is explicit
     * that dimension keys are "machine identifiers, never display text", so
     * a template has no other way to show a human label — resolved via
     * `t[key]` the same way band keys are, falling back to the raw key.
     */
    label: z.string().min(1),
    value: z.number().finite(),
    /** `value` formatted for display (one decimal place, trailing `.0` trimmed). */
    valueLabel: z.string().min(1),
    /** `scores.bands[key]`, or null when the ScoreSet has no band for this dimension. */
    bandKey: z.string().nullable(),
    /** Resolved via `t[bandKey]`; falls back to the raw key when no translation exists. */
    bandLabel: z.string().nullable(),
    /** 0-100, relative to the highest dimension value in this score set. */
    barPercent: z.number().min(0).max(100),
  })
  .strict();
export type ReportMergeDimension = z.infer<typeof reportMergeDimensionSchema>;

/**
 * The Zod-validated context handed to the merge engine and snapshotted to
 * `reports.data` (spec 09: rendering never re-queries live data, so
 * historical reports are reproducible byte-for-byte). Assessment-agnostic:
 * scores arrive as the normalized ScoreSet, display copy as resolved
 * translation strings under `t.*` — nothing here is PRO-D-specific.
 *
 * Respondent names are report CONTENT (they appear on the report), stored in
 * the database only — never logged, never in URLs (spec 00 PII rule).
 */
export const reportMergeContextSchema = z
  .object({
    report: z.object({
      id: z.string().uuid(),
      kind: reportKindSchema,
      /** BCP47 language the report copy was resolved in. */
      language: z.string().min(1),
      /** ISO-8601 assembly instant. */
      generatedAt: z.string().min(1),
      /**
       * Human-readable rendering of `generatedAt` in the report's language
       * (e.g. "23 July 2026") — added for E5's template header. The merge
       * engine has no date-formatting helper (spec 09/E3: "no conditionals,
       * no helpers, no expressions"), so any template needing a display date
       * needs it pre-formatted here rather than parsing `generatedAt` itself.
       */
      generatedAtLabel: z.string().min(1),
      pageSize: reportPageSizeSchema,
    }),
    order: z.object({
      id: z.string().uuid(),
      /** Display-only human reference (ORD-00042) — never used in URLs. */
      reference: z.string().min(1),
    }),
    product: z.object({
      name: z.string().min(1),
      slug: z.string().min(1),
    }),
    respondent: z.object({
      firstName: z.string(),
      lastName: z.string(),
      fullName: z.string(),
    }),
    session: z.object({
      completedAt: z.string().nullable(),
    }),
    /** The session's normalized score document (spec 08 ScoreSet). */
    scores: scoreSetSchema,
    /** Per-dimension rows for `{{#each dimensions}}` — see reportMergeDimensionSchema. */
    dimensions: z.array(reportMergeDimensionSchema),
    /** Resolved translation strings for the report language (B4). */
    t: z.record(z.string(), z.string()),
  })
  .strict();
export type ReportMergeContext = z.infer<typeof reportMergeContextSchema>;
