# AGENTS.md

This repo also has `CLAUDE.md`; **you must load it first** for project architecture, rules, service scripts, Supabase migration policy, testing, and browser notes. CLAUDE.md in turn points to [WORKTREES.md](WORKTREES.md) — **load that too** whenever you're working in a git worktree or running parallel agents.

## Local Setup Notes

- Local self-hosted Supabase lives outside this repo at:
  `C:\Users\Owner\Projects\TAIA Full Stack AI Platform\supabase-local`
- Start Supabase from that folder with:
  `docker compose up -d`
- Do not use `supabase start`; this repo expects the Docker Compose stack on `http://localhost:8000`.
- Apply app migrations from this repo with:
  `powershell -ExecutionPolicy Bypass -File scripts\run-migrations-local.ps1`
- Backend env changes, including `LLM_API_KEY` and `EMBEDDING_API_KEY`, require a backend restart.

## Service Startup

- Use PowerShell for npm and service scripts on Windows.
- If PowerShell script execution is blocked, run scripts with `-ExecutionPolicy Bypass`.
- Start backend in this environment with:
  `powershell -ExecutionPolicy Bypass -File scripts\start-backend.ps1 -NoReload`
- Start frontend with:
  `powershell -ExecutionPolicy Bypass -File scripts\start-frontend.ps1`
- Verify:
  `http://localhost:8001/health` -> `{"status":"ok"}`
  `http://localhost:5173` -> frontend page

## Pull Requests

- `origin/master` is branch-protected: you cannot push to or merge it directly. Every change lands via a pull request.
- `gh` is NOT installed here. For this local dev machine only, an ignored `PULL-REQUESTS.md` file may exist with copy-paste GitHub REST API steps that use the token Git Credential Manager already holds. That file is machine-specific local guidance, must stay out of git, and should not be treated as project documentation.

## Worktrees: Per-Worktree Ports + Shared Database

**[WORKTREES.md](WORKTREES.md) is the single source of truth** for the dev/worktree
workflow (ports, shared DB + venv, per-worktree test accounts, landing work, safe removal).
Read it before any worktree work. Agent-specific notes:

- Mandatory first action for AI coding agents: after creating or entering a git
  worktree, provision the worktree dev environment before creating/switching
  branches, starting services, running tests, editing code, or using the browser.
  Codex: invoke `$worktree-dev-env` (or choose **Worktree Dev Environment** from
  `/skills`). Claude Code: invoke `/worktree-dev-env`. The fallback/manual command is:
  `powershell -ExecutionPolicy Bypass -File scripts\setup-worktree.ps1` — sets its ports,
  shares `backend\venv` and `frontend\node_modules`, recreates the local npm fallback when
  needed, and provisions its own test accounts.
- If `.worktree-ports.json` already exists, verify provisioning before continuing with
  `powershell -ExecutionPolicy Bypass -File scripts\health-check.ps1`.
- Check a worktree's ports with
  `powershell -ExecutionPolicy Bypass -File scripts\health-check.ps1`.
- Removing a worktree when done: Claude Code: invoke `/worktree-dev-remove`. Codex:
  invoke `$worktree-dev-remove` (or choose **Remove Worktree** from `/skills`). The
  fallback/manual command is
  `powershell -ExecutionPolicy Bypass -File scripts\remove-worktree.ps1 -Path "<worktree-path>" -DeleteBranch`
  — it deletes the worktree's test accounts and unlinks the shared `backend\venv` /
  `frontend\node_modules` junctions before removal. Never recursive-delete a worktree
  that still has those junctions.
- **Shared database (critical):** every worktree + the main checkout share the one local
  Supabase DB on `http://localhost:8000`. Data is global — a **migration or `pip install`
  from one worktree affects all of them**. Coordinate; avoid destructive DDL while other
  agents work. (Full rationale + the test-account exception are in WORKTREES.md.)

## Codex Browser Validation

- For Codex sessions, use the native Codex in-app Browser plugin for ad-hoc UI exploration and local browser validation. Do not use the `agent-browser` CLI guidance from `CLAUDE.md` unless the user explicitly asks for it or the in-app Browser is unavailable and you explain the fallback.
- Every frontend change must be verified in the in-app Browser before the task is considered complete. Open or reload `http://localhost:5173`, exercise the affected user flow, and inspect the visible result for errors, blank states, layout overlap, and console errors.
- If in-app Browser bulk text entry (`fill`/`type`) fails with the virtual clipboard helper, keep testing in the in-app Browser and enter text through focused key presses instead. Do not treat that helper failure as a reason to skip browser validation or switch to non-browser-only verification.
- Automated Playwright E2E tests are still appropriate for regression coverage, but they do not replace the required in-app Browser smoke check for frontend work.
- Include screenshots from the in-app Browser when they help show the verified state or when the user asks for visual confirmation.
- When embedding local screenshots in a response, use Markdown image tags with absolute paths formatted with forward slashes, for example `![Chat smoke](<C:/Users/Owner/Projects/TAIA Full Stack AI Platform/agentic-rag-app/.codex-browser-screenshots/chat-smoke.png>)`. Do not use Windows backslash paths inside image tags because they may not render in Codex.

## Node/NPM Quirk

This machine did not have global `npm` available. A local npm fallback is installed under ignored `.tools/`, with `.tools\bin\npm.cmd` pointing at Codex's bundled Node runtime. `scripts\setup-worktree.ps1` recreates that fallback in worktrees when needed; if setup warns that the main fallback is missing, recreate it there or install Node/npm globally before starting the frontend.
