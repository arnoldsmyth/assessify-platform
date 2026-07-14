"""Assessify pdf-service — HTML in, PDF out.

Contract (docs/spec/09-reports-and-pdf.md):

    POST /render     (internal network only, shared-secret header)
    { "html": "<!doctype html>...",   # option B (preferred)
      "url": "http://web.internal:3000/report-print/{id}?...",  # option A
      "pageSize": "a4" | "letter" }
    -> 200 application/pdf  |  4xx/5xx { "error": "..." }

The service is deliberately dumb and stateless: no report knowledge, no
storage, no auth beyond the shared secret. Generated PDFs are streamed back
and never written anywhere.
"""

from __future__ import annotations

import hmac
import logging
import os
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, model_validator

from .renderer import RenderError, render_pdf

logger = logging.getLogger("pdf-service")

SECRET_HEADER = "x-pdf-service-secret"
SECRET_ENV = "PDF_SERVICE_SHARED_SECRET"

app = FastAPI(title="assessify-pdf-service", docs_url=None, redoc_url=None)


class RenderRequest(BaseModel):
    """Exactly one of `html` (preferred) or `url` (fallback) must be set."""

    html: str | None = None
    url: str | None = None
    pageSize: Literal["a4", "letter"] = "a4"

    @model_validator(mode="after")
    def _exactly_one_source(self) -> "RenderRequest":
        if (self.html is None) == (self.url is None):
            raise ValueError("provide exactly one of 'html' or 'url'")
        return self


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@app.exception_handler(RequestValidationError)
async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    detail = str(first.get("msg", "invalid request body"))
    return _error(400, detail)


def _check_secret(request: Request) -> JSONResponse | None:
    """Shared-secret check. If the env var is unset (local dev), auth is off."""
    expected = os.environ.get(SECRET_ENV)
    if not expected:
        return None
    provided = request.headers.get(SECRET_HEADER, "")
    if not hmac.compare_digest(provided.encode(), expected.encode()):
        return _error(401, "invalid or missing shared secret")
    return None


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


# Sync `def` on purpose: FastAPI runs it in a threadpool, so a long WeasyPrint
# render does not block the event loop. Concurrency = uvicorn workers (see
# Dockerfile CMD; spec 09 targets 2 workers x N processes).
@app.post("/render")
def render(request: Request, body: RenderRequest) -> Response:
    denied = _check_secret(request)
    if denied is not None:
        return denied

    try:
        pdf = render_pdf(html=body.html, url=body.url, page_size=body.pageSize)
    except RenderError as exc:
        logger.warning("render failed: %s", exc)
        return _error(422, str(exc))
    except (OSError, ImportError) as exc:  # missing native libs (pango etc.)
        logger.error("renderer unavailable: %s", exc)
        return _error(503, "pdf renderer unavailable")

    return Response(content=pdf, media_type="application/pdf")
