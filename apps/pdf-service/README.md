# pdf-service

Internal HTML-to-PDF rendering service: **Python 3.12 + FastAPI + WeasyPrint**.
Replaces DocRaptor/Prince with the same paged-CSS model (`@page`,
`page-break-*` / `break-after`), zero per-document cost, and **no JavaScript at
render time** — charts must be server-rendered SVG in the markup.

Source of truth for the contract: `docs/spec/09-reports-and-pdf.md`.
Topology: `docs/spec/03-architecture.md` — this component is **internal-only**
(never routable publicly), stateless, and never stores a PDF.

This app is intentionally **outside the pnpm/turbo graph** (Python, not Node).

## Contract

```
POST /render                      (shared-secret header, see Auth)
{ "html": "<!doctype html>...",   // option B (preferred): fully inlined HTML
  "url":  "http://web.internal:3000/report-print/{id}?...",  // option A fallback
  "pageSize": "a4" | "letter" }   // default "a4"
→ 200 application/pdf
→ 4xx/5xx { "error": "..." }

GET /healthz → { "status": "ok" }
```

- Exactly one of `html` / `url` must be provided; anything else is a `400`.
- `pageSize` is applied as an appended `@page { size: ... }` stylesheet, so the
  request value wins over any default in the document.
- Render failures return `422 { error }`; missing native libraries return `503`.

### Auth

Callers send the shared secret in the `X-Pdf-Service-Secret` header. The
service compares it (constant-time) against the `PDF_SERVICE_SHARED_SECRET`
env var. If the env var is **unset** (local dev), the check is disabled.
In deployed environments it must always be set (DO App Platform encrypted env
var), and the component must not be publicly routable.

The TypeScript client lives at
`packages/adapters/src/pdf/providers/weasyprint.ts` (`WeasyPrintPdfRenderer`),
implementing the `PdfRenderer` interface from `@assessify/adapters`.

## Local development

Dependencies are managed with [uv](https://docs.astral.sh/uv/) (`uv.lock` is
committed; CI and Docker use `--frozen`).

WeasyPrint needs a native Pango/HarfBuzz stack:

- **macOS:** `brew install pango` (pulls glib, harfbuzz, fontconfig)
- **Debian/Ubuntu:** `apt install libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0`

macOS quirk: Homebrew's libs aren't on the default dyld search path, and
hardened-runtime binaries strip `DYLD_*` vars across shebang execs — so export
the fallback path **and** invoke tools as `python -m ...`:

```bash
cd apps/pdf-service
uv sync                 # creates .venv with dev deps
export DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib   # macOS only
uv run python -m uvicorn app.main:app --reload --port 8080
```

Smoke test:

```bash
curl -s -X POST localhost:8080/render \
  -H 'content-type: application/json' \
  -d '{"html": "<h1>hello</h1>", "pageSize": "a4"}' \
  -o /tmp/out.pdf
```

## Tests

```bash
cd apps/pdf-service
uv run python -m pytest      # `python -m` keeps DYLD_* alive on macOS
```

- `tests/test_api.py` — contract tests against the FastAPI app (validation,
  auth, error shape). The renderer is monkeypatched, so these run without the
  native WeasyPrint stack.
- `tests/test_golden.py` — **golden-file tests** (spec 09): fixture HTML
  documents with paged CSS are rendered with real WeasyPrint and compared to
  committed goldens in `tests/golden/*.json`. The comparison is deliberately
  deterministic across machines: **page count + per-page extracted text**
  (via `pypdf`), never raw PDF bytes (which vary with library versions and
  metadata). These tests **skip cleanly** if WeasyPrint's native libraries are
  unavailable.

To regenerate goldens after an intentional template/fixture change:

```bash
uv run python -m pytest tests/test_golden.py --update-goldens
```

Review the golden diff in the PR like any other code change.

## Deployment (DO App Platform)

Build from `apps/pdf-service/Dockerfile`. Internal-only component on port
8080; health check `GET /healthz`. Concurrency: 2 uvicorn workers per
container (spec 09) — scale the component horizontally if renders queue.
Required env: `PDF_SERVICE_SHARED_SECRET`.
