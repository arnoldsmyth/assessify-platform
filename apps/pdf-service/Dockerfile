# Assessify pdf-service — WeasyPrint + FastAPI (docs/spec/09-reports-and-pdf.md)
# Built for DigitalOcean App Platform (internal-only component, port 8080).
FROM python:3.12-slim

# Native stack WeasyPrint needs (Pango >= 1.44 for text layout, HarfBuzz for
# font subsetting). DejaVu is the last-resort fallback font; brand fonts are
# expected to arrive inlined in the HTML payload as base64 @font-face.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        libharfbuzz0b \
        libharfbuzz-subset0 \
        libfontconfig1 \
        fonts-dejavu-core \
        shared-mime-info \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.7.13 /uv /usr/local/bin/uv

WORKDIR /srv/pdf-service

# Dependencies first for layer caching; locked, production-only.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app

ENV PATH="/srv/pdf-service/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

# Non-root runtime user.
RUN useradd --system --no-create-home pdfsvc
USER pdfsvc

EXPOSE 8080

# Concurrency per spec 09: 2 uvicorn workers per process; scale the DO
# component horizontally if renders queue.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
