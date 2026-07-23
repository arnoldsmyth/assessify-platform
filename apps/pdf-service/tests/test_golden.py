"""Golden-file tests (docs/spec/09-reports-and-pdf.md).

Fixture HTML documents with paged CSS are rendered through the real service
path (TestClient POST /render -> WeasyPrint) and compared against committed
goldens in tests/golden/*.json.

Comparison method — chosen for determinism across machines and documented per
spec 09 ("HTML snapshot + PDF page-count assertion"; the HTML here *is* the
committed fixture, i.e. the snapshot):

  * page count
  * page dimensions in PDF points (rounded) — proves @page size + the
    request pageSize override took effect
  * per-page extracted text, whitespace-normalised (pypdf)

Raw PDF bytes are intentionally NOT compared: they embed library versions and
metadata that vary between environments. Text + geometry is stable for the
same WeasyPrint major version.

Skips cleanly when the native WeasyPrint stack is unavailable.
To regenerate after an intentional change: `uv run pytest --update-goldens`.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from .conftest import weasyprint_unavailable_reason

_reason = weasyprint_unavailable_reason()
pytestmark = pytest.mark.skipif(_reason is not None, reason=_reason or "")

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN = Path(__file__).parent / "golden"

CASES = [
    ("report_basic", "a4"),
    ("report_basic", "letter"),  # request pageSize must override @page size
    ("report_multipage", "a4"),
    # E5 (asy-izb.5): the real PRO-D template, ALREADY MERGED — this is
    # `mergeTemplate()`'s output against the fixture context in
    # packages/services/src/reports/templates/pro-d/fixture.ts (byte-identical
    # to that package's own golden, `templates/pro-d/__golden__/report.merged.html`).
    # Proves the assembled report paginates correctly through the real
    # pdf-service, not just that the merge engine produces valid markup.
    ("report_pro_d", "a4"),
]


def _normalise(text: str) -> str:
    return " ".join(text.split())


def _summarise(pdf_bytes: bytes) -> dict:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(pdf_bytes))
    return {
        "page_count": len(reader.pages),
        "page_size_pts": [
            [round(float(p.mediabox.width)), round(float(p.mediabox.height))]
            for p in reader.pages
        ],
        "pages_text": [_normalise(p.extract_text()) for p in reader.pages],
    }


@pytest.mark.parametrize(("fixture", "page_size"), CASES)
def test_golden(
    client: TestClient, fixture: str, page_size: str, update_goldens: bool
) -> None:
    html = (FIXTURES / f"{fixture}.html").read_text(encoding="utf-8")
    response = client.post("/render", json={"html": html, "pageSize": page_size})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF-")

    summary = _summarise(response.content)
    golden_path = GOLDEN / f"{fixture}.{page_size}.json"

    if update_goldens:
        GOLDEN.mkdir(exist_ok=True)
        golden_path.write_text(
            json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        pytest.skip(f"golden updated: {golden_path.name}")

    assert golden_path.exists(), (
        f"missing golden {golden_path.name} — run `uv run pytest --update-goldens` "
        "and commit the result"
    )
    expected = json.loads(golden_path.read_text(encoding="utf-8"))
    assert summary == expected
