# Vibe-Trading sidecar image (HKUDS/Vibe-Trading, MIT — see THIRD_PARTY_NOTICES.md).
#
# Deliberately its own image, same isolation reasoning as rag-api: the
# vibe-trading-ai dependency tree (LangChain/LangGraph, modern pandas) conflicts
# with the qlib API's pinned stack and must never be installed into AION_IMAGE.
#
# One image, two compose services:
#   vibe-api  — REST API + agent sessions:  vibe-trading serve --host 0.0.0.0 --port 8000
#   vibe-mcp  — 64-tool MCP server:         vibe-trading-mcp --transport http --host 0.0.0.0 --port 8900
#
# All runtime state lives under ~/.vibe-trading (the vibe-home named volume).
#
# The frontend stage builds their React SPA from the repo tag matching the
# wheel. api_server.py serves <two-dirs-above-itself>/frontend/dist as a
# static SPA when present — with the wheel installed in site-packages that is
# /usr/local/lib/python3.12/frontend/dist — so the full Vibe UI rides on the
# API port (8899) same-origin: no extra service, no CORS, their SSE-ticket
# auth works unchanged. Their frontend calls the API with relative paths
# (BASE = "" in frontend/src/lib/api.ts), which is what makes this sound.
ARG VIBE_TAG=v0.1.13

FROM node:22-alpine AS frontend
ARG VIBE_TAG
RUN apk add --no-cache git \
    && git clone --depth 1 --branch ${VIBE_TAG} \
       https://github.com/HKUDS/Vibe-Trading /src
WORKDIR /src/frontend
RUN npm ci && npm run build

FROM python:3.12-slim

# ibkr: Interactive Brokers connector (user-priority broker; Alpaca/Binance/OKX
# ride on the core install's REST/ccxt deps). anthropic: Claude as the agent LLM.
RUN pip install --no-cache-dir "vibe-trading-ai[ibkr,anthropic]==0.1.13"

COPY --from=frontend /src/frontend/dist /usr/local/lib/python3.12/frontend/dist

RUN useradd --create-home --uid 1000 vibe
USER vibe
ENV HOME=/home/vibe
WORKDIR /home/vibe

EXPOSE 8000 8900
# Command is set per compose service.
CMD ["vibe-trading", "serve", "--host", "0.0.0.0", "--port", "8000"]
