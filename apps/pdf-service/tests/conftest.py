from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--update-goldens",
        action="store_true",
        default=False,
        help="Rewrite tests/golden/*.json from the current render output.",
    )


@pytest.fixture
def update_goldens(request: pytest.FixtureRequest) -> bool:
    return bool(request.config.getoption("--update-goldens"))


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def weasyprint_unavailable_reason() -> str | None:
    """Non-None (with the underlying error) when WeasyPrint cannot load.

    WeasyPrint needs native Pango/HarfBuzz libraries; on macOS install them
    with `brew install pango`. Import failure must skip the golden tests
    cleanly rather than erroring.
    """
    try:
        import weasyprint  # noqa: F401
    except Exception as exc:  # OSError from dlopen, ImportError, etc.
        return (
            "WeasyPrint native dependencies unavailable "
            f"(install pango/harfbuzz, e.g. `brew install pango`): {exc}"
        )
    return None
