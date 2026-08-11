from typing import Literal
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # Supabase
    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: str
    # Only used for LEGACY symmetric (HS256) Supabase signing. When the instance
    # signs tokens with asymmetric keys (ES256/RS256) — the default for newer
    # self-hosted setups — the backend verifies via the JWKS endpoint instead and
    # this can stay empty. For HS256 mode set it to the JWT_SECRET from the
    # supabase docker .env (Supabase Cloud: Settings -> API -> JWT Secret).
    supabase_jwt_secret: str = ""

    # LangSmith
    langsmith_api_key: str = ""
    langsmith_project: str = "rag-masterclass"

    # Tracing provider: "langsmith", "langfuse", or "" (disabled)
    tracing_provider: str = ""

    # Langfuse
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_host: str = "http://localhost:3000"

    # LLM
    llm_model: str = "gpt-4o"
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_context_window: int = 128000
    # How to map the per-request "thinking" toggle to a provider param on the
    # OpenAI-compatible path. "auto" infers from llm_base_url (openrouter ->
    # reasoning.effort, openai -> reasoning_effort, anything else -> omit). Pin
    # it if detection is wrong. (Codex uses codex_reasoning_effort instead.)
    llm_reasoning_style: Literal["auto", "openrouter", "openai", "none"] = "auto"

    # LLM provider selector. "", "openrouter", "openai" all behave identically
    # (OpenAI-compatible base_url + api_key — today's behavior). "codex" routes the
    # primary chat + agent loops through a ChatGPT/Codex subscription, reading the
    # credentials written by `codex login` to ~/.codex/auth.json. Utility calls
    # (redaction, metadata, compaction, title) and embeddings always stay on the
    # LLM_*/EMBEDDING_* providers regardless of this setting.
    llm_provider: Literal["", "openrouter", "openai", "codex"] = ""

    # Codex (Sign in with ChatGPT) — only used when llm_provider == "codex".
    codex_model: str = "gpt-5.5"
    codex_home: str = ""  # override for ~/.codex; falls back to $CODEX_HOME then ~/.codex
    # Reasoning effort for gpt-5 family: "", "minimal", "low", "medium", "high", "xhigh".
    codex_reasoning_effort: str = ""
    # Reasoning summary for the Responses API: "auto"|"concise"|"detailed"|"" (off).
    # When set (and reasoning is on), Codex streams a summary we surface in the
    # chat's "Thought process" panel. Set to "" if the backend rejects it.
    codex_reasoning_summary: str = "auto"
    codex_base_url: str = "https://chatgpt.com/backend-api/codex"

    # Chunking strategy: "smart" preserves Markdown hierarchy; "simple" is a recursive char splitter.
    chunking_strategy: Literal["simple", "smart"] = "smart"

    # Document ingestion / Docling
    # Run native PDF/OCR extraction in a child Python process so a native crash
    # fails one document instead of killing the API worker.
    ingestion_process_isolation_enabled: bool = True
    # Docling PDF preprocessing performs large native allocations. Keep the
    # defaults bounded so multi-file upload bursts queue instead of running
    # every conversion pipeline at once.
    ingestion_max_concurrent_documents: int = 4
    docling_max_concurrent_conversions: int = 2
    docling_device: str = "auto"
    docling_num_threads: int = 8
    docling_batch_size: int = 1
    docling_table_batch_size: int = 4
    docling_queue_max_size: int = 8
    docling_do_ocr: bool = True
    docling_do_table_structure: bool = True
    docling_table_mode: Literal["accurate", "fast"] = "accurate"
    docling_ocr_mode: Literal["auto", "always", "never"] = "auto"
    docling_force_full_page_ocr: bool = False
    docling_ocr_auto_max_pages: int = 50
    docling_ocr_auto_min_chars_per_page: int = 60
    docling_ocr_auto_min_readable_page_ratio: float = 0.8
    docling_ocr_auto_min_text_area_ratio: float = 0.01
    docling_ocr_auto_min_text_density: float = 40.0
    docling_ocr_auto_min_visual_area_ratio: float = 0.2
    docling_ocr_backend: Literal["auto", "onnxruntime", "openvino", "paddle", "torch"] = "auto"
    docling_pdf_backend: Literal[
        "docling_parse",
        "threaded_docling_parse",
        "pypdfium2",
        "dlparse_v1",
        "dlparse_v2",
        "dlparse_v4",
    ] = "docling_parse"
    # Large PDFs are split into page-range windows and stitched back together.
    # This also bounds per-conversion memory: the docling-parse backend
    # accumulates native memory per page and bypasses the pipeline's streaming
    # bounds, so a large born-digital PDF can OOM the host (see plan 22).
    # Converting in page-range windows releases the backend between windows.
    # 0 disables page-window chunking (single-shot conversion).
    docling_max_pages_per_chunk: int = 50
    # Per-document cap for running multiple page windows from the same PDF at
    # once. Each window still consumes one global docling_max_concurrent_conversions
    # slot. Keep at 1 for the sequential, memory-bounded default; raising it
    # trades memory for throughput.
    docling_max_parallel_page_chunks_per_document: int = 1
    # Recycle the per-thread Docling converter(s) after this many documents to
    # avoid cross-document converter-reuse accumulation (docling #2209). 0 = never.
    docling_converter_recycle_after: int = 1
    # Preflight rejects (status=failed) before conversion. These catch only
    # *pathological* (gigapixel-scale) pages/images — e.g. a page declared near
    # the 14,400 pt PDF max or inflated via /UserUnit, or a decompression-bomb
    # image — NOT legitimate large-format sheets (an ANSI-E 34x44 in drawing is
    # ~70 MP at 216 DPI). The per-page hard memory ceiling (plan 22 Phase 2) is
    # the real backstop. 0 disables the respective check.
    docling_max_page_pixels: int = 250_000_000
    docling_max_image_pixels: int = 200_000_000
    # If Docling+RapidOCR returns no text for an image-only PDF, render pages
    # with pypdfium2 and run RapidOCR directly as a recovery path.
    docling_ocr_blank_fallback_enabled: bool = True
    docling_ocr_blank_fallback_scale: float = 3.0
    docling_ocr_sparse_fallback_min_chars_per_page: int = 120
    docling_pdf_text_layer_fallback_enabled: bool = True
    docling_pdf_text_layer_fallback_min_chars: int = 200
    docling_pdf_text_layer_fallback_min_ratio: float = 0.5
    metadata_extraction_timeout_seconds: int = 45

    # Embedding
    embedding_model: str = "text-embedding-3-small"
    embedding_base_url: str = ""
    embedding_api_key: str = ""
    embedding_dimensions: int = 1536

    # Reranking (optional — empty base_url = disabled)
    rerank_model: str = "rerank-v3.5"
    rerank_base_url: str = ""
    rerank_api_key: str = ""
    rerank_top_n: int = 5

    # Web Search (optional)
    web_search_provider: str = "tavily"
    web_search_api_key: str = ""
    web_search_enabled: bool = False
    # Capture each result's full page text so web citations can render a source
    # snapshot and highlight the cited snippet when it appears there. Stored in
    # web_snapshots, not sent to the LLM.
    web_search_include_raw_content: bool = True
    web_search_max_snapshot_chars: int = 200_000
    # "advanced" extracts full page text for (almost) every result and favours
    # real article pages over data-only API endpoints, so web citations get
    # snapshots instead of falling back to a bare link. "basic" is cheaper
    # (1 Tavily credit vs 2) but leaves many sources without extractable text.
    web_search_depth: str = "advanced"

    # Local LLM for PII entity resolution (optional)
    local_llm_model: str = ""
    local_llm_base_url: str = ""

    # SQL Agent (read-only database user)
    sql_reader_database_url: str = ""

    # PII redaction toggle — set to false to skip the entire pipeline
    pii_redaction_enabled: bool = True

    # PII entity resolution: "llm", "algorithmic", or "none"
    entity_resolution_mode: str = "llm"

    # PII entity types that get reversible Faker surrogates (can be de-anonymized)
    pii_surrogate_entities: str = "PERSON,EMAIL_ADDRESS,PHONE_NUMBER,LOCATION,DATE_TIME,URL,IP_ADDRESS"

    # PII entity types that get hard-redacted with [TYPE] placeholders (never reversed)
    pii_redact_entities: str = "CREDIT_CARD,US_SSN,US_ITIN,US_BANK_NUMBER,IBAN_CODE,CRYPTO,US_PASSPORT,US_DRIVER_LICENSE,MEDICAL_LICENSE"

    # Presidio score thresholds (0.0 - 1.0)
    pii_surrogate_score_threshold: float = 0.7
    pii_redact_score_threshold: float = 0.3

    # Whether to run a secondary LLM scan for hard-redact PII that Presidio missed
    pii_missed_scan_enabled: bool = True

    # Code Sandbox
    sandbox_enabled: bool = False
    sandbox_max_execution_time: int = 60
    sandbox_max_memory_mb: int = 512
    sandbox_session_ttl_minutes: int = 30
    sandbox_container_image: str = "sandbox-python:latest"
    sandbox_max_concurrent_sessions: int = 5

    # Sub-agent LLM (optional — falls back to primary LLM when empty)
    sub_agent_model: str = ""
    sub_agent_base_url: str = ""
    sub_agent_api_key: str = ""

    # "Check Citations" grounding checker. A utility call, so it stays on the
    # LLM_* provider even when llm_provider == "codex". Empty = use llm_model;
    # a cheaper model (e.g. gpt-4o-mini) is plenty for a per-citation verdict.
    citation_check_model: str = ""

    # Agentic loop
    max_tool_rounds: int = 25
    max_deep_rounds: int = 50
    max_sub_agent_rounds: int = 15

    # Context compaction
    compaction_enabled: bool = True
    compaction_trigger_ratio: float = 0.75   # fraction of llm_context_window before compaction kicks in
    keep_recent_turns: int = 10              # minimum user+assistant pairs to keep verbatim
    keep_recent_tokens: int = 20000          # token budget for the recent buffer (overrides turns if hit first)
    compaction_model: str = ""               # empty = use llm_model; can be a cheaper model like gpt-4o-mini
    compaction_max_per_thread: int = 50      # safety cap on compactions per thread
    compaction_summary_max_tokens: int = 2000

    # Tool Registry
    tool_registry_enabled: bool = False
    catalog_max_tools: int = 50

    # Sandbox HTTP Bridge
    bridge_port: int = 8002
    bridge_session_token_ttl_minutes: int = 30
    # SECURITY (finding D-001): the sandbox runs attacker-influenceable code that can
    # call POST /bridge/call with ANY tool name. This allowlist is the confused-deputy
    # boundary — ONLY these (read-only) tools may be invoked from the sandbox and are
    # advertised via /bridge/catalog. Deliberately EXCLUDES execute_code (recursive
    # sandbox), save_skill / upload_skill_file / write_file / edit_file (persistent
    # writes) and task (sub-agent spawn). Also excludes tool_search, whose executor
    # returns FULL schemas for the entire registry — allowlisting it would let the
    # sandbox enumerate the hidden tools it must not see. New/MCP tools are denied by
    # default (fail-closed). To override via env, set a JSON array, e.g.
    # SANDBOX_BRIDGE_TOOL_ALLOWLIST='["search_documents","web_search"]' — and only
    # after vetting each added tool.
    sandbox_bridge_tool_allowlist: list[str] = [
        "search_documents",
        "analyze_document",
        "explore_knowledge_base",
        "get_document_sections",
        "get_document_structure",
        "web_search",
        "calculator",
        "ls",
        "tree",
        "grep",
        "glob",
        "read",
        "read_file",
        "list_files",
        "load_skill",
        "read_skill_file",
    ]

    # MCP servers (Phase 3) — comma-separated "name:command:args" entries
    mcp_servers: str = ""

    # Citation modes (see citation_mode_spec.md)
    # Quick Mode (unverified, model-authored inline citations) is the only path.
    citation_fast_mode_enabled: bool = True
    # Runaway-guard cap on aliases per turn. Plan 23 removed the per-source span
    # caps so every Category-1 passage in context is citable; this is only a
    # safety ceiling against a pathological turn, not a budget that should starve
    # tool calls. Set high enough never to bite in normal use -- lazy citation
    # streaming (Plan 23 Task A4) keeps the frontend payload small even at high
    # alias counts.
    citation_max_aliases_per_turn: int = 5000

    # Remote skill import (skills.sh / GitHub). Optional token raises GitHub's
    # rate limit (60 -> 5000/hr) and enables importing from private repos.
    github_token: str = ""

    # CORS
    cors_origins: list[str] = ["http://localhost:5173"]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"
        protected_namespaces = ("model_",)


@lru_cache
def get_settings() -> Settings:
    return Settings()
