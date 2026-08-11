# Monorepo-local image for the vendored Aion-RAG backend (service `rag-api` in
# the root docker-compose.yml). Deliberately separate from Dockerfile.dev: the
# RAG stack pins fastapi/uvicorn versions that conflict with the qlib API, and
# docling's native parsers are kept out of the shared qlib image.
#
# Source is NOT baked in — the repo's rag/ tree is bind-mounted at /rag, same
# dev convention as the qlib services. Rebuild only when requirements.txt
# changes:  docker compose build rag-api
FROM python:3.11-slim-bookworm

# libgl1 + libglib2.0-0: opencv (rapidocr); libgomp1: onnxruntime OpenMP
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

WORKDIR /rag/backend

COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install --upgrade pip \
    && pip install -r /tmp/requirements.txt

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
