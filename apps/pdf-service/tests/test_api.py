"""Contract tests for the /render endpoint (docs/spec/09-reports-and-pdf.md).

The renderer is monkeypatched, so these run anywhere — no native WeasyPrint
stack required. Real rendering is covered by test_golden.py.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.renderer import RenderError

FAKE_PDF = b"%PDF-1.7 fake"


@pytest.fixture
def fake_renderer(monkeypatch: pytest.MonkeyPatch) -> dict:
    calls: dict = {}

    def _render(*, html=None, url=None, page_size="a4") -> bytes:
        calls.update(html=html, url=url, page_size=page_size)
        return FAKE_PDF

    monkeypatch.setattr(main, "render_pdf", _render)
    return calls


def test_healthz(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_render_html_returns_pdf(client: TestClient, fake_renderer: dict) -> None:
    response = client.post("/render", json={"html": "<h1>hi</h1>", "pageSize": "letter"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content == FAKE_PDF
    assert fake_renderer == {"html": "<h1>hi</h1>", "url": None, "page_size": "letter"}


def test_render_url_returns_pdf(client: TestClient, fake_renderer: dict) -> None:
    response = client.post(
        "/render", json={"url": "http://web.internal:3000/report-print/abc?sig=x"}
    )
    assert response.status_code == 200
    assert fake_renderer["url"] == "http://web.internal:3000/report-print/abc?sig=x"
    assert fake_renderer["page_size"] == "a4"  # default


@pytest.mark.parametrize(
    "body",
    [
        {},  # neither source
        {"html": "<p>x</p>", "url": "http://web.internal/x"},  # both sources
        {"html": "<p>x</p>", "pageSize": "tabloid"},  # unsupported page size
    ],
)
def test_invalid_body_is_400_with_error_shape(client: TestClient, body: dict) -> None:
    response = client.post("/render", json=body)
    assert response.status_code == 400
    payload = response.json()
    assert set(payload) == {"error"}
    assert isinstance(payload["error"], str) and payload["error"]


def test_render_failure_is_422_with_error_shape(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(**_kwargs) -> bytes:
        raise RenderError("bad markup")

    monkeypatch.setattr(main, "render_pdf", _boom)
    response = client.post("/render", json={"html": "<broken"})
    assert response.status_code == 422
    assert response.json() == {"error": "bad markup"}


def test_missing_native_libs_is_503(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(**_kwargs) -> bytes:
        raise OSError("cannot load library 'libpango-1.0-0'")

    monkeypatch.setattr(main, "render_pdf", _boom)
    response = client.post("/render", json={"html": "<p>x</p>"})
    assert response.status_code == 503
    assert response.json() == {"error": "pdf renderer unavailable"}


class TestSharedSecret:
    def test_rejected_without_header(
        self, client: TestClient, fake_renderer: dict, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(main.SECRET_ENV, "s3cret")
        response = client.post("/render", json={"html": "<p>x</p>"})
        assert response.status_code == 401
        assert set(response.json()) == {"error"}

    def test_rejected_with_wrong_secret(
        self, client: TestClient, fake_renderer: dict, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(main.SECRET_ENV, "s3cret")
        response = client.post(
            "/render",
            json={"html": "<p>x</p>"},
            headers={main.SECRET_HEADER: "wrong"},
        )
        assert response.status_code == 401

    def test_accepted_with_correct_secret(
        self, client: TestClient, fake_renderer: dict, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(main.SECRET_ENV, "s3cret")
        response = client.post(
            "/render",
            json={"html": "<p>x</p>"},
            headers={main.SECRET_HEADER: "s3cret"},
        )
        assert response.status_code == 200
        assert response.content == FAKE_PDF

    def test_auth_disabled_when_env_unset(
        self, client: TestClient, fake_renderer: dict, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv(main.SECRET_ENV, raising=False)
        response = client.post("/render", json={"html": "<p>x</p>"})
        assert response.status_code == 200
