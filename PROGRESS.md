# Progress

> **Honest status board.** This file tracks what has been **verified working in the running
> app**, episode by episode — not what code merely exists. Reset on 2026-06-29 at the start
> of the full 7-episode rebuild (plan: `~/.claude/plans/the-report-suggests-that-zesty-hopcroft.md`).
>
> Status legend: ⬜ Not yet verified · 🔄 In progress · ✅ Runtime-verified · ⚠️ Partial / known gap

## Method
Each episode is rewritten/repaired in place against its PRD (`.agent/plans/reference/`), then
proven live (real upload / chat / citation + DB rows) before we move on. We pause for approval
at every episode boundary. A feature is only ticked ✅ once observed working end-to-end.

## Runtime Baseline (Phase 0) — ✅ verified 2026-06-29
- ✅ Backend `:8001` healthy, frontend `:5173` loads (200), all 11 `aionrag-*` containers up
- ✅ Migrations current (59 files, all applied; latest `20260611000002_thread_child_cascade`)
- ✅ "Before" DB snapshot: 1 document · 729 chunks · 3 threads · 9 messages · 4 answer_citations · 3 users
  (the 4 citations confirm today's forced-search fix fired at least once)

---

## Episode 1 — Agentic RAG Foundation  ✅ 8/8 verified (web search disabled by config)
Runtime-verified 2026-06-29 via authenticated end-to-end test as `test@test.com`
(uploaded `zephyr-memo.md` with fictional facts → grounded answer cited "Marigold"/"137",
facts present only in that doc). Earlier "no search/no citations" was **RLS isolation**
(test user owned no docs), **not** a code defect — the core RAG loop works.
- ✅ Module 1: App Shell — auth (token grant), thread create, SSE `text_delta` streaming
- ✅ Module 2: BYO Retrieval + Memory — upload → 2 chunks, both embedded; grounded answer
- ✅ Module 3: Record Manager — identical re-upload returned `action=skipped`, same doc id
- ✅ Module 4: Metadata Extraction — metadata populated (title/topics[]/summary/language/document_type), not "Unknown"
- ✅ Module 5: Multi-Format — MD ✅, PDF ✅ (729-chunk doc), DOCX ✅, HTML ✅ all ingest to completed (image OCR not exercised, Docling onnxruntime configured)
- ✅ Module 6: Hybrid Search — forced round-1 `search_documents` fired; retrieval returned the right chunks
- ✅ Module 7a: Text-to-SQL — **re-wired & verified.** `query_sales_database` fired in chat and returned correct per-region revenue + top product (matched DB exactly). Required: re-seed `sales_data` WITH RLS (migration `20260629190000_reseed_sales_data_demo.sql`), re-add tool schema in `build_rag_tools` (gated on `include_sql`), executor routing in `tool_executor.py`, enable in `chat.py` (gated on `sql_reader` DSN), `sql_reader` password + `SQL_READER_DATABASE_URL` (pooler `:5533`, tenant-suffixed user) in `backend/.env`.
- ⏸️ Module 7b: Web search — implemented but **disabled by config** (`WEB_SEARCH_ENABLED=false`, no Tavily key). Enable with a key when needed. (User decision: leave off, documented.)
- ✅ Module 8: Subagents — `analyze_document` spawned isolated-context sub-agent (`sub_agent_start`→reasoning→`sub_agent_complete`); correctly extracted DOCX-only facts with citations

**Test note:** backend unit suite green except 2 pre-existing, unrelated failures in
`test_workspace_service.py` (`_infer_content_type` for `.md`/`.xyz`) — a macOS `mimetypes`
registry quirk, not caused by this work. Flag for the Episode 2 workspace pass.

## Episode 2 — Knowledge Base Explorer  ✅ verified 2026-06-29 (1 gap repaired)
Runtime-verified end-to-end as `test@test.com`. Code was complete (21/21 reqs); fixed one
real robustness gap.
- ✅ Folders: nested create (A>B>C), rename, **cycle prevention** (move-under-descendant → 400),
  global/per-user toggle, **cascade delete** (removes child folders + their documents)
- ✅ Breadcrumbs/ancestry: `GET /folders/{id}/ancestors` returns the chain
- ✅ Upload into a specific folder (`folder_id` honored)
- ✅ Explorer tools all exercised live: `ls`, `tree`, `grep` (via explorer sub-agent run),
  `glob` + `read` (via direct chat) — answers grounded in folder-scoped docs
- ✅ Explorer sub-agent (`explore_knowledge_base`): `explorer_start`→tool calls→`explorer_complete`,
  synthesized a cited briefing from a folder's docs
- 🔧 **Gap repaired:** `ls`/`tree`/`grep` `_resolve_path` documented folder-name support but
  only accepted `'root'`/UUID → explorer errored when given a folder name. Now resolves a name
  against the user's visible folders (`folder_navigation.py`); tool descriptions updated; added
  `test_folder_path_resolution.py` (6 tests).
- 🔧 **Bonus fix:** `_infer_content_type` (workspace_service) was platform-dependent via stdlib
  `mimetypes` (the 2 pre-existing failing tests) → now a deterministic extension map. Full unit
  suite green (415 passed).

**Minor note (not a blocker):** `GET /documents/{id}` returns HTTP 500 (PGRST116) instead of
404 for a missing/deleted document — error-handling polish, flagged for later.

## Episode 3 — PII Redaction & Anonymization  ✅ core verified 2026-06-29
Enabled `PII_REDACTION_ENABLED=true` (was off) and verified end-to-end as `test@test.com`.
Deps present (presidio 2.2.363, spaCy `en_core_web_lg`). **No code changes needed** — core
is correct and the previously-flagged sub-agent gap is already fixed.
- ✅ Presidio NER detection (PERSON/EMAIL/PHONE/SSN/CREDIT_CARD…)
- ✅ Reversible Faker surrogates: name/email/phone replaced for the LLM, **round-tripped back
  to real values** in the user-facing answer
- ✅ Hard redaction: valid SSN → `[US_SSN]`, card → `[CREDIT_CARD]`, **not reversed, not stored**
  in the registry
- ✅ Per-thread registry persists reversible mappings (`thread_entity_registry`); confirmed via DB
- ✅ **Core security guarantee:** DB shows the LLM only ever saw surrogate `anonymized_content`;
  real PII stayed in `content` (de-anonymized) only
- ✅ `redaction_status` SSE events (anonymizing/deanonymizing) fire
- ✅ Sub-agent coverage: `run_task_agent` (previously flagged) now anonymizes input +
  deanonymizes output, matching `run_sub_agent`/`run_explorer_agent` (confirmed in code)
- ✅ Algorithmic resolution: first-name sub-surrogate derivation works (Marcus→David within
  identity David Barnett)
- ⚠️ **Known limitation (not fixed):** algorithmic mode parses a *bare surname* ("Delgado") as a
  first name → not clustered with the full name (got "Mr. Timothy" vs "Mr. Barnett"). Non-default
  mode; no security/round-trip impact (user still sees correct text via deanonymization). Hard NLP
  edge case — documented, deferred.
- ⏸️ Config-gated (need a local LLM, like web search): `ENTITY_RESOLUTION_MODE=llm` clustering and
  the missed-PII LLM scan fall back/skip without `LOCAL_LLM_BASE_URL`. Core works regardless.

**Note:** Presidio over-detects some labels as PERSON (e.g. the word "Email") — benign
over-redaction, transparently reversed. Validation correctly rejects invalid placeholder SSNs
(e.g. `123-45-6789`), so use valid-format SSNs when testing.

## Episode 4 — Skills & Code Sandbox  ✅ verified 2026-06-29 (1 security gap repaired)
Built the sandbox image (`sandbox-python:latest`), enabled `SANDBOX_ENABLED=true` (local .env).
- ✅ Skills CRUD via REST: create, list, enable-toggle, delete
- ✅ Skill building-block files: upload + list
- ✅ Export skill to valid `.zip` (SKILL.md format); import round-trip parses + validates +
  reports per-skill naming conflict without crashing
- ✅ Skill tools (load_skill/save_skill/read_skill_file/upload_skill_file) wired in chat
- ✅ Code sandbox via chat: `execute_code` runs Python in Docker (`code_execution_start`→`complete`),
  correct results (fib(20)=6765, Σsquares=338350)
- ✅ File generation: `result-*.txt` written to `/sandbox/output`, auto-discovered, uploaded, and
  recorded in `workspace_files` (source=`sandbox`) with signed URL
- 🔧 **Security gap repaired (defense-in-depth):** the sandbox security policy
  (`get_python_security_policy` — blocks subprocess/os.system/eval/exec/ctypes…) was attached to
  the llm-sandbox session but **never enforced** — `run()` doesn't auto-check it, and nothing
  called `is_safe()`. So dangerous code executed at the sandbox layer (the only protection was the
  model's own refusal). Fixed `sandbox_service.run_code_execution` to call `session.is_safe(code)`
  before running and emit `code_execution_error` on violation. Verified live: `subprocess`/`os.system`
  now blocked, benign code still runs. Added `test_sandbox_security.py` (3 tests). Full unit suite: 418 passed.

**Note:** generated files use the `workspace_files` table/`workspace-files` bucket; the
`sandbox_files` table from the migration appears legacy/unused (not a functional gap).

## Episode 5 — Advanced Tool Calling  ✅ verified 2026-06-29 (1 bug fixed; MCP gap documented)
Enabled `TOOL_REGISTRY_ENABLED=true` (local .env) to verify the gated features.
- ✅ Context-window indicator: `usage` SSE event (prompt/completion/total tokens) + `/settings/public`
  returns `context_window: 128000` (frontend renders the bar against it)
- ✅ Persistent tool memory: `messages.tool_calls` JSONB stores full `result` + `result_summary` +
  `tool_name`/`arguments`/`status`; reconstructed on load (`_rebuild_tool_messages`)
- ✅ Unified tool registry + `tool_search`: live chat showed `tool_search` → discovered + loaded the
  deferred `calculator` → computed 7,006,751 correctly
- ✅ Sandbox HTTP bridge: full round-trip — sandbox code called `tool_client.list_tools()` (15 tools)
  and `tool_client.call('search_documents', …)` (returned real doc content) over container→host
  (`host.docker.internal:8001`)
- 🔧 **Bug fixed:** `/bridge/catalog` required an `X-Bridge-Token` **header**, but the sandbox
  `bridge_client` sends `?session_token=` (query param) → `list_tools()`/`search()` silently returned
  `[]` (422 swallowed). Aligned the endpoint to the query param (`bridge.py`). Verified: `?session_token=bogus`
  → 401 (was 422), plus the live round-trip above.
- ⚠️ **MCP client — documented gap:** wiring is complete (startup init, schema conversion, reconnect)
  and `mcp` is imported lazily, but the **`mcp` package isn't installed** and `MCP_SERVERS=[]`. To use
  MCP: `pip install mcp` (+ pin in requirements.txt) + configure `MCP_SERVERS` + run an external MCP
  server. Not driven live (needs an external server).

**Behavior trade-off to note:** enabling the tool registry **disables the Episode-1 forced-first-search
grounding guard** (`force_first_search` requires `not registry_enabled`). With the registry on, round-1
`search_documents` is no longer forced — the model discovers/uses tools freely instead.

**Not chased (unconfirmed/UI):** `tool_calls[n].sub_agent_state`/`code_execution_state` for full
process-panel reload fidelity — core tool memory works; these would enrich reload rendering only.

## Episode 6 — Agent Harness & Deep Mode  ✅ verified 2026-06-29 (ask_user gap implemented)
Verified end-to-end (no flag needed — deep mode is per-message; harness via `harness_mode`).
- ✅ Deep Mode: extended prompt + planning/workspace/delegation tools loaded on `deep_mode=true`
- ✅ Planning todos: `write_todos`/`read_todos` → `todos_updated` SSE; `agent_todos` rows with status
  tracking (3 todos all `completed` in test)
- ✅ Agent workspace: `write_file` → `workspace_file_created`; files persisted (`plan.md`, `summary.md`)
- ✅ Sub-agent delegation: `task` tool → `run_task_agent` (`sub_agent_start`→`complete`); sub-agent found
  the Zephyr codename "Marigold" from RAG and wrote it to `summary.md`
- ✅ Harness engine: ran the **full 8-phase Contract Review** to `completed` —
  Document Intake (programmatic) → Classification (llm_single) → Gather Context (**llm_human_input,
  paused + resumed**) → Load Playbook (llm_agent) → Clause Extraction → Risk Analysis
  (**llm_batch_agents**) → Redline Generation (**llm_batch_agents**) → Executive Summary. All 5 phase
  types exercised; 12 parallel `harness_sub_agent` runs across the batch phases.
- ✅ Gatekeeper + phase→todo mapping + workspace file writes per phase
- ✅ DOCX report generation: produced a 41,952-byte `Contract_Review_Report_*.docx` +
  `contract-review-report.md`, `redlines.md`, `risk-analysis.md`
- ✅ File upload to workspace (`POST /threads/{id}/files/upload`)
- 🔧 **`ask_user` tool — IMPLEMENTED (gap closed).** Added the `ask_user` planning tool
  (`llm_service`), executor handler (`tool_executor`), and pause/resume in the deep-mode loop
  (`chat.py`): when the agent calls `ask_user`, the question is surfaced (`ask_user` SSE + visible
  text), the turn ends, and the conversation pauses; the user's next message resumes the task.
  Excluded from sub-agents (`deep_agent_service`). Verified live: agent asked "How many people will
  attend?" → paused → on "8 people" it resumed and continued for 8. Tests: `test_ask_user_tool.py`
  (3) + updated 2 existing tests. Full suite: 421 passed.

## Episode 7 — Citations & Source Grounding  ✅ verified 2026-06-29
- ✅ Evidence markers — `{[S#]}` tokens injected into tool results before LLM invocation; rendered in chat (verified live: grounded answer streamed with `{[S1]}` marker + `citation_alias`/`citation_metadata` SSE events).
- ✅ Collision-resistant tokens — canonical span IDs (`doc_<id>.span_NNNN_<hash>`) from source+span content; confirmed in `threads.citation_aliases` / `answer_citations`.
- ✅ Thread-stable numbering — display numbers persist in `threads.citation_aliases` JSONB (verified: 18 stable spans with monotonic display numbers seeded + merged across turns).
- ✅ Check-citations verifier — `POST /threads/{tid}/messages/{mid}/check-citations` returns 200, grades each citation (verified/partially_supported/not_verified/contradicted + support_score), persists verdicts to `answer_citations`, and flips `messages.verification_mode` → `semantic-text` (verified live: verdict `verified`, score 1.0, DB updated).
- ✅ Layout-aware ingestion + page-space bboxes — `documents.document_layout` JSONB populated by Docling for PDFs (verified: 170 pages, A4 page-space dims 595.32×841.92, bbox geometry present).
- ✅ Dual-face / citable chunks — `chunks.citable_text` populated for highlight matching (verified: 738/738 chunks).
- ✅ Frontend citation UI — `CitationButton`, `CitationSourceViewer` (PDF/text/web + bbox overlay), `CitationSourcePanel`, `CitationPreviewPopover` wired; citation tokens → links via `citationUtils.ts`.
- 📝 Notes: `citation_grounding_service` uses `OPENAI_API_KEY` for LLM grading. Agent-flagged "`document_render` column missing" is a non-issue — `document_render` is an in-memory dataclass/module name, not a DB column (the schema uses `document_layout`). Minor cosmetic items only: `citation_fast_mode_enabled` config flag is unused; `get_result_summary()` undercounts result tokens (display-only, Episode 1 area). Citation unit suite: 109 passed.
