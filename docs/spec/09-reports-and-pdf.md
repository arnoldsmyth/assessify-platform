# 09 — Reports & PDF Generation

Reports are generated after scoring. **One React template per product**, versioned (`report_template_versions`), consumed in two modes: interactive web view and print (PDF). Templates are code, not UI-editable.

## Assembly

Worker job `report.assemble` (fired by `applyScores`, or by group-order close for aggregates):
1. Build the full render-data object: scores, band labels, narrative text (resolved via `translation_strings` for `orders.report_language`), respondent display name, product branding, dates. Snapshot it to `reports.data` — rendering never re-queries live data, so historical reports are reproducible byte-for-byte.
2. `reports.status = 'ready'`; if the product/client policy is auto-release → `released` (else a client/admin releases manually — release controls per respondent or bulk).
3. Fire completion notifications per resolved policy (`13`) when the order reaches `completed`.

Aggregate reports (`group` orders with `report_model` aggregate/both, and `multi_rater`): assembled across all completed sessions of the order; `reports.session_id` null; rater data grouped by `rater_relationship` with **minimum-N anonymity** (default: never show a rater group with fewer than 3 raters individually; fold into "Other" — configurable per product).

## Web view

`/(respondent)/a/[token]/report` (token+PIN gate, only when `released`) and admin `/reports/[id]`. The template component receives `{ data, branding, mode: 'web' }` and renders responsive HTML. Charts are **server-rendered SVG components** (no client-side charting dependency) — the same SVG works in print.

## PDF — WeasyPrint service (replaces DocRaptor)

**Decision:** WeasyPrint, self-hosted (`apps/pdf-service`, Python 3.12 + FastAPI). Rationale: legacy templates were built for DocRaptor/Prince = static HTML + paged CSS; WeasyPrint implements the same `@page` model with zero per-document cost. Constraint accepted: **no JavaScript at render time** — charts must be SVG in markup (already required above). If a future template genuinely needs a browser engine, implement a Puppeteer `PdfRenderer` adapter; the interface hides the engine.

### Contract

```
POST http://pdf-service.internal:8080/render     (internal network only, shared-secret header)
{ "url": "http://web.internal:3000/report-print/{reportId}?pageSize=a4&sig=...",   // option A
  "html": "<!doctype html>...",                                                     // option B (preferred)
  "pageSize": "a4" | "letter" }
→ 200 application/pdf (streamed)  |  4xx/5xx { error }
```

**Preferred flow (option B):** the web app renders the print route server-side itself (React → HTML string via the same template component with `mode:'print'`), with **all assets inlined** — fonts base64 `@font-face`, images as data URIs, zero external fetches — and POSTs the HTML to pdf-service. This keeps pdf-service dumb (HTML in, PDF out), stateless, and free of auth complexity. Option A (URL fetch with a short-lived signed URL) is the fallback if payloads get too large.

### PdfRenderer adapter (service layer view)

```ts
interface PdfRenderer { render(input: { reportId: string; pageSize: 'a4'|'letter' }): Promise<ReadableStream> }
```
Adapter implementation: load `reports.data` → render print HTML → POST to pdf-service → stream the PDF straight to the client response. **No PDF is written to disk or storage** — generated on demand every time. (Exception: migrated legacy PDFs, below.)

### Print template rules

- `mode:'print'` renders fixed-size page containers: each logical section is a page `<section class="page">` with `break-after: page`; `@page { size: A4|letter; margin: ... }` is the only per-size difference. Templates bake in white space to absorb ±1–2 lines of variable narrative; overflow is treated as a template bug (design constraint), not a runtime concern.
- Fonts: the product's brand fonts subsetted and embedded; fallback stack defined in `15`.
- Performance target: 23-page report < 10s, expected 1–3s with inlined assets. pdf-service concurrency: default 2 workers × N processes; scale the component horizontally if queueing.
- Golden-file tests: fixture `reports.data` → HTML snapshot + PDF page-count assertion per template version in CI (WeasyPrint runs in the CI container).

## Access & downloads

- Admin/client (scope-checked): view web report, download PDF (`GET /reports/{id}/pdf?pageSize=`).
- Respondent: token+PIN gate; product/client config decides auto-release vs held.
- External share: `report_access_links` — time-limited token URL (default 14 days), revocable, each access audited.
- Every download/view writes `audit_log` (`report.viewed`, `report.downloaded`).

## Legacy reports

Migrated orders have `reports.legacy_pdf_path` pointing at Firebase Storage. Report detail shows a "legacy report" badge; download streams from storage via the Storage adapter's signed URL (never regenerated, pdf-service not involved).
