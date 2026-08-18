# scalability_agent

The background worker service behind the venue scalability tool. The AION
platform (`webapp/api`) is the control plane: it accepts fund uploads and
enqueues rows into `aion.scalability_jobs`. This service is the data plane:
it polls that table, claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED`,
runs the analysis engine (`scalability_agent.engine`), and writes reports to
`aion.scalability_reports` plus a rendered HTML artifact in the private
Supabase Storage bucket `scalability-uploads`.

It has no inbound API except `/health`, holds its own service-role
credentials (it is the only writer of job/report state and bypasses RLS
deliberately), and never forwards anything to a venue — the booking consent
gate lives entirely in the platform API.

## Layout

```
scalability_agent/
  agent/      # service half: config, db (queue), storage, worker, main
  engine/     # analysis half: parse_upload / analyze pipeline + heuristics
  report/     # render_html(result) -> self-contained HTML report
```

## Environment variables

Read from the process environment, or from the repo-root `.env` when running
locally (gitignored — see `.env.example`).

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(required)* | Raw Postgres to the Supabase database; the agent runs as `service_role`. |
| `SUPABASE_URL` | `http://host.docker.internal:8010` | Supabase HTTP base, used for the Storage REST API. |
| `SUPABASE_SERVICE_ROLE_KEY` | *(required)* | Service-role key for private-bucket Storage access. |
| `AGENT_POLL_SECONDS` | `5` | Queue poll interval when idle. |
| `AGENT_WORKERS` | `2` | Concurrent jobs per replica. Scale out with more replicas; SKIP LOCKED keeps claims safe. |
| `AGENT_LEASE_SECONDS` | `120` | How long a claimed job may run before the reaper requeues it. |
| `AGENT_HEARTBEAT_SECONDS` | `30` | Per-job heartbeat interval; must stay well below the lease. |
| `AGENT_MAX_ATTEMPTS` | `3` | Total attempts before a job is permanently `failed`. |
| `AGENT_PORT` | `8771` | Port for the `/health` HTTP server. |

## Run locally

```bash
.venv/Scripts/python.exe -m scalability_agent.agent.main
curl http://localhost:8771/health
```

## Run via compose

The `agent` service lives in `docker-compose.dev.yml` and uses the same image as
the `api` service with the entrypoint above:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d agent
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f agent
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec agent curl -s http://localhost:8771/health
```

## Tests

```bash
.venv/Scripts/python.exe -m pytest scalability_agent -q
```

## End-to-end smoke

With the stack up (`docker compose up -d api ui` plus the optional services if
you need them), enqueue a parse job and an analyze job straight into the queue,
then watch the agent claim them:

```bash
# 1. Insert an upload row pointing at a file already in the
#    'scalability-uploads' bucket, then enqueue the parse job:
docker compose exec db psql -U postgres -d postgres -c "
  INSERT INTO aion.scalability_uploads (user_id, org_id, filename, storage_path)
  VALUES ('<user-uuid>', '<org-uuid>', 'trades.csv', '<org-uuid>/trades.csv')
  RETURNING id;"

docker compose exec db psql -U postgres -d postgres -c "
  INSERT INTO aion.scalability_jobs (user_id, org_id, kind, upload_id)
  VALUES ('<user-uuid>', '<org-uuid>', 'parse_upload', '<upload-uuid>');"

# 2. Enqueue an analysis over the parsed upload:
docker compose exec db psql -U postgres -d postgres -c "
  INSERT INTO aion.scalability_jobs (user_id, org_id, kind, upload_id, params)
  VALUES ('<user-uuid>', '<org-uuid>', 'analyze', '<upload-uuid>', '{\"current_venue\": \"IBKR\"}');"

# 3. Watch the agent claim and finish them:
docker compose logs -f agent
docker compose exec db psql -U postgres -d postgres -c \
  "SELECT kind, status, attempts, error FROM aion.scalability_jobs ORDER BY created_at;"
```

Crash-recovery check: `docker compose kill agent` while a job is running,
wait for `AGENT_LEASE_SECONDS`, restart — the reaper requeues the orphaned
job and a fresh worker picks it up.
