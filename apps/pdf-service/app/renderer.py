"""WeasyPrint rendering, isolated from the HTTP layer.

WeasyPrint is imported lazily so the FastAPI app (and its contract tests) can
run on machines without the native Pango/HarfBuzz stack — only an actual
render attempt requires it.
"""

from __future__ import annotations

# Paged-CSS page size applied from the request. WeasyPrint treats extra
# stylesheets as *user* origin, which loses to the document's own @page rule,
# so `!important` is required (user-important beats author) to make the
# request's pageSize authoritative — templates keep `@page { size: ... }`
# only as a default (docs/spec/09-reports-and-pdf.md).
_PAGE_SIZE_CSS = {
    "a4": "@page { size: A4 !important; }",
    "letter": "@page { size: letter !important; }",
}


class RenderError(Exception):
    """Raised when WeasyPrint cannot produce a PDF from the given input."""


def render_pdf(
    *,
    html: str | None = None,
    url: str | None = None,
    page_size: str = "a4",
) -> bytes:
    """Render an HTML document (string or fetched from an internal URL) to PDF bytes."""
    from weasyprint import CSS, HTML  # lazy: needs native pango/harfbuzz

    if page_size not in _PAGE_SIZE_CSS:
        raise RenderError(f"unsupported pageSize: {page_size!r}")

    try:
        if html is not None:
            document = HTML(string=html)
        elif url is not None:
            document = HTML(url=url)
        else:
            raise RenderError("either html or url is required")
        return document.write_pdf(
            stylesheets=[CSS(string=_PAGE_SIZE_CSS[page_size])]
        )
    except RenderError:
        raise
    except Exception as exc:  # WeasyPrint raises a variety of exception types
        raise RenderError(f"render failed: {exc}") from exc
