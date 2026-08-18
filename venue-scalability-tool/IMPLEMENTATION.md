# Scalability Agent — Platform Implementation Design

Companion to `PRD.md`. Answers: how the scalability tool ships as **a
separate, standalone agent** that users can activate in the background —
manually, via the chat assistant, or on a schedule — and that produces a
report.

**Decision (per Thomas): the agent is its own process/service, not code
inside `webapp/api`.** The platform enqueues work; the agent picks it up,
does the analysis, and writes back a report. Rationale:

- Fund trading data is the most sensitive data AION touches — isolating its
  processing in a separate service with its own credentials and no inbound
  HTTP surface is worth more than the convenience of in-process threads.
- Ceiling simulation is CPU-heavy; a separate service scales (replicas)
  without competing with the API for the machine.
- The agent can be deployed, restarted, and versioned independently of the
  platform — important while the calculation (Phase 0) is still evolving.

---

## 1. Architecture

```
                        AION platform (webapp — unchanged role)
 ┌────────────────────────────────────────────────────────────────┐
 │ UI page ──┐                                                     │
 │ Chat tool ─┼─► routers/scalability.py ──► enqueue job row       │
 │ Scheduler ─┘    (upload, booking,        aion.scalability_jobs  │
 │                 report read,                                   │
 │                 consent gate) ────────►  aion.scalability_*     │
 └────────────────────────────────────────────────────────────────┘
                     │  jobs table (Postgres = the queue)
                     ▼  polled / LISTEN-NOTIFY
 ┌────────────────────────────────────────────────────────────────┐
 │ scalability_agent  (separate process / Docker service)            │
 │                                                                 │
 │  worker loop ──► claim job (SKIP LOCKED) ──► run engine:        │
 │    profile → liquidity → costs → ceiling → compare → render     │
 │                                                                 │
 │  writes: report.json + PDF artifact ──► Supabase Storage        │
 │          aion.scalability_reports row, job status               │
 │                                                                 │
 │  no inbound API except /health; service-role DB access          │
 └────────────────────────────────────────────────────────────────┘
```

Postgres is the queue — the platform already persists scheduled tasks and
runs there, so no Redis/RabbitMQ dependency is introduced. The agent claims
jobs with `SELECT … FOR UPDATE SKIP LOCKED`, which also makes running
**multiple agent replicas** safe from day one.

### Activation paths (all three enqueue the same job type)

1. **Manual** — UI: upload trade file → "Analyze" → job enqueued → UI polls
   job/report status → report page.
2. **Chat** — assistant calls `start_scalability_analysis` (enqueues), then
   `get_scalability_report` to narrate the finished report.
3. **Scheduled** — `TaskScheduler` kind `scalability_report`: instead of
   running work in-process like `_run_strategy`, it just **enqueues a job**
   and records the report id when the job lands.

## 2. The agent service

New top-level package (standalone, like `webapp/` is). As built:

```
scalability_agent/
  agent/
    main.py          # entrypoint: poll loop, graceful shutdown, /health
    worker.py        # claim job → lease/heartbeat → dispatch → finalize
    db.py            # jobs/uploads/reports/catalog access (psycopg)
    storage.py       # Supabase Storage download/upload helpers
  engine/
    pipeline.py      # parse_upload / analyze orchestration
    params.py        # v1 heuristic assumptions, all named constants
    profile.py       # M2 strategy fingerprint from normalized trades
    liquidity.py     # M3 depth/impact model per venue
    costs.py         # M4 fee/eligibility evaluation vs. catalog
    ceiling.py       # M5 simulation → ceiling + decomposition
    compare.py       # M6 venue ranking + "why" explanations
  report/
    render.py        # M7 report.json → HTML
```

(The original sketch had `scalability-agent/agent/engine/` plus an `ingest/`
package for broker statement parsers; as built, M1 parsing lives in
`engine/pipeline.py` and the package is `scalability_agent/` — underscore,
so it is importable. The report artifact is HTML, not PDF, for now.)

- **Worker loop:** poll every few seconds (or `LISTEN/NOTIFY` for wakeups
  with polling as fallback). On claim: set `status='running'`, lease with
  heartbeat; on success write report + `status='succeeded'`; on failure
  record error + retry budget, then `status='failed'`.
- **Crash recovery:** a job whose lease expired without heartbeat is
  re-queued automatically — the agent-side equivalent of
  `RunManager.reconcile_orphans`.
- **Concurrency:** `AGENT_WORKERS` (default 2) jobs in flight per replica;
  scale horizontally by adding replicas, SKIP LOCKED prevents double-claim.
- **The engine has no FastAPI/platform imports** — pure Python, testable
  from notebooks in Phase 0, imported by the worker in Phase 1. Same
  relationship `webapp/` has to `qlib/` today.
- **Deploy:** new `agent` service in `docker compose`, next to `api`/`ui`.
  Same image family as the API (needs qlib + pandas) — as built it reuses
  `${AION_IMAGE}` and the same `webapp/.env` env_file rather than shipping
  its own Dockerfile, and reads the same `DATABASE_URL`/Supabase settings
  plus the `AGENT_*` tunables documented in `webapp/.env.example`.

## 3. What stays in the platform (`webapp/api`)

Thin, and deliberately so — the platform is the control plane, the agent is
the data plane:

- `routers/scalability.py` — upload (to private Storage bucket), enqueue
  job, job/report status + report fetch, booking endpoints.
- **Consent gate lives here, never in the agent:** the venue-forwarding
  endpoint requires `aion.scalability_bookings.report_shared_at` non-NULL,
  set only by the booking-completion path. The agent never forwards anything
  to anyone.
- `chat_tools.py` — three tools (profile-gated):
  `start_scalability_analysis(upload_id, candidate_venues?)`,
  `get_scalability_report(run_id)`,
  `book_venue_consultation(report_id, venue)` — the last initiates booking
  only; forwarding still fires only on the completed booking event.
- `scheduler.py` — one `if kind == "scalability_report"` branch that
  enqueues instead of executing.

## 4. Persistence (Supabase, `aion` schema)

- `aion.scalability_uploads` — upload metadata, parse status, derived
  instrument/size summary. Raw file in a private Storage bucket, RLS-scoped
  to the fund's org; the agent reads it with its service role.
- `aion.scalability_jobs` — the queue: `status`, `params` (upload id,
  candidate venues), `lease_expires_at`, `heartbeat_at`, `attempts`,
  `result_report_id`, timestamps. This is the agent's only input channel.
- `aion.scalability_reports` — one row per finished job: ceilings per venue
  (jsonb), decomposition (jsonb), confidence, `catalog_version`, artifact
  path. Reports are reproducible: same inputs + catalog version → same
  output.
- `aion.venue_catalog` — versioned venue profiles (fees, eligibility rules
  like "UBS ≥ $20M AUM", liquidity params).
- `aion.scalability_bookings` — booking events + `report_shared_at` consent
  gate (§3).

RLS as everywhere else: funds see only their own rows; the platform API
enforces ownership; the agent's service key is scoped to what it needs.

## 5. Operational flow end-to-end

1. Fund uploads IBKR statement → platform stores file, enqueues
   `parse_upload` job.
2. Agent parses → writes summary to `scalability_uploads` → fund confirms
   "what we understood" preview.
3. Fund (or chat, or schedule) starts analysis → `analyze` job enqueued.
4. Agent runs the engine → `report.json` + PDF to Storage →
   `scalability_reports` row → job `succeeded`.
5. UI/chat reads the report; fund books via venue link; booking completion
   sets `report_shared_at`. (Email-forwarding of the report to the venue is
   deferred — as built, booking only flips the consent gate; no message is
   sent to the venue yet. The React report/booking page is likewise
   deferred; this milestone ships backend + agent only.)

## 6. What changes in existing files (minimal)

- `webapp/api/main.py` — include the new router.
- `webapp/api/chat_tools.py` — three tool registrations + schemas.
- `webapp/api/scheduler.py` — one enqueue-only branch.
- `docker compose` / stack files — the `agent` service.
- Supabase migration — the five tables above with RLS.

No changes to `qlib/`, `scripts/`, `examples/`, `runner.py`, or any existing
backtest/ingest/macro path. The agent is fully additive.

## 7. Phasing (aligned with PRD §9)

- **Phase 0 (gate):** `agent/engine/` only, driven from a notebook/script
  against hand-built cases (incl. the IBKR→UBS example). No service, no
  tables. Validates the calculation — go/no-go for the rest.
- **Phase 1:** agent service + jobs table + platform router + report
  rendering + booking consent gate. Invite-only. Chat tools optional but
  cheap once enqueue exists.
- **Phase 2:** scheduled re-checks, venue-catalog drift re-runs ("your
  ceiling moved" notifications), generic CSV import, catalog growth.
- **Phase 3:** revenue attribution, multiple agent replicas if volume
  demands it.

## 8. Open decisions

1. Poll interval vs. `LISTEN/NOTIFY` (start with polling — simpler, matches
   the scheduler's existing style).
2. Report artifact: HTML-only for MVP vs. HTML→PDF from day one.
3. Agent Docker image: share the API's image with a different command, or a
   slimmer dedicated image.
4. Does chat get booking initiation in Phase 1, or is booking UI-only until
   the consent flow is battle-tested?
