# Onboarding: building AION on a new machine

Everything you need to go from `git clone` to a working app. Written against
**Linux x86_64 + Docker**, which is the supported path; the bare-metal
alternative is in [§10](#10-bare-metal-alternative-no-docker).

Budget: **~15 minutes to a running UI**, plus **several hours** for the market
data ingest, which you can start and walk away from.

---

## 1. What this is

A fork of [microsoft/qlib](https://github.com/microsoft/qlib) carrying the AION
webapp in `webapp/`. Nothing under `qlib/`, `scripts/` or `examples/` is modified
— AION is an additive layer that drives the engine the same way the bundled
notebooks and benchmarks do.

The fork keeps upstream's full history, so pulling qlib changes still works:

```bash
git remote -v
# origin    git@github.com:tbvisser/Aion-Qlib.git     (this fork)
# upstream  https://github.com/microsoft/qlib         (for merges)
```

`upstream` is not configured by a fresh clone — add it if you want it:

```bash
git remote add upstream https://github.com/microsoft/qlib
```

## 2. Prerequisites

| | |
|---|---|
| git | any recent version |
| Docker Engine | with the **compose v2 plugin, ≥ 2.24** (`docker compose version`) — the optional `env_file` syntax below needs it |
| disk | **~15 GB** free: ~3 GB image, ~1.4 GB qlib stores, ~4.4 GB ingest cache, ~500 MB derived parquet, plus room for run output |
| RAM | **~12 GB available to the container** for a full `top500` Alpha158 backtest. On a 7.8 GB Docker VM that run is SIGKILLed part-way (exit `-9`); smaller universes are fine. Native Linux Docker uses host memory directly, so this is mostly a Docker Desktop concern — but do check `docker info --format '{{.MemTotal}}'` before blaming the code. |

Docker Desktop is not required on Linux; Engine + the compose plugin is enough.
Make sure your user is in the `docker` group so you are not running compose under
`sudo` (which would defeat §5).

## 3. Clone — to a path with no spaces

The repo is **private**, so the clone needs credentials. SSH is the path of least
resistance: add the new machine's public key at
<https://github.com/settings/keys>, then

```bash
git clone git@github.com:tbvisser/Aion-Qlib.git aion-qlib
cd aion-qlib
```

HTTPS works too, but note that a `gh auth login` token needs the **`workflow`**
scope or the first `git push` is rejected outright — the history contains
upstream qlib's own `.github/workflows/`, so this bites on push even if you never
touch a workflow file. Fix with `gh auth refresh -s workflow`, or just use SSH,
which is not subject to the OAuth scope check.

The original checkout lives in a directory containing a space, and that space is
now baked into 116 MLflow `meta.yaml` artifact URIs there. Nothing is known to be
broken by it, but it is a standing quoting hazard in every shell script and
subprocess call. Don't reproduce it.

## 4. Secrets

```bash
cp webapp/.env.example webapp/.env
chmod 600 webapp/.env
```

Then fill in two keys:

| Key | Where from | Needed for |
|---|---|---|
| `EODHD_API_KEY` | <https://eodhd.com/cp/dashboard> | all market data — this is a **paid** subscription |
| `OPENROUTER_API_KEY` | <https://openrouter.ai/keys> | the chat assistant and plain-language strategy builder |

Transfer them **out of band** — a password manager, or an encrypted channel.
Never paste them into the repo, a Dockerfile, a CI log, or a chat window.

`webapp/.env` is gitignored, and `Dockerfile.dev.dockerignore` excludes it from
the build context so it cannot end up in an image layer. The `api` and `jupyter`
services read it at runtime via `env_file`. Both protections are asserted in CI
(`.github/workflows/publish-image.yml`) — if you ever edit the dockerignore,
that check is what stops a key reaching the registry.

The app starts without these keys; it just can't fetch data or chat.

## 5. Linux: file ownership

**Skip this on macOS.** Docker Desktop remaps ownership for you; Linux does not.

The containers bind-mount this repo and write into it — run records, MLflow
output, recompiled `.so` files. Running as root, they leave root-owned files your
host user can't edit or delete. Tell compose who you are:

```bash
printf 'DOCKER_UID=%s\nDOCKER_GID=%s\n' "$(id -u)" "$(id -g)" >> .env
```

That root-level `.env` configures compose itself, is gitignored, and is separate
from `webapp/.env`, which configures the app. See `.env.example` for the full set.

## 6. Get the image

```bash
docker compose pull        # ~2 min, published by CI
```

Or build it yourself, which is the source of truth and works offline:

```bash
AION_IMAGE=qlib-dev:local docker compose build qlib   # ~5-8 min
echo 'AION_IMAGE=qlib-dev:local' >> .env              # make it stick
```

If the GHCR package is private, authenticate first with a PAT carrying
`read:packages`:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u tbvisser --password-stdin
```

## 7. Build the market data

**This is the long pole: several hours, and it spends EODHD API quota.**

The app needs a qlib binary store. Until one exists, every data endpoint answers
`503 No qlib data store found` (`webapp/api/qlib_session.py`, `resolve_store`).

Do a small run first to prove the pipeline and your key work — a few minutes:

```bash
docker compose run --rm qlib python -m webapp.ingest \
    --universe-size 25 --limit 25 --start 2020-01-01
```

If that lands, do the real one:

```bash
docker compose run --rm qlib python -m webapp.ingest \
    --universe-size 500 --start 2010-01-01
docker compose run --rm qlib python -m webapp.ingest.build_stores --all
```

What you get, and where:

| Path | Size | What |
|---|---|---|
| `~/.qlib/qlib_data/us_eodhd` | ~875 MB | primary store: top-500 US names by dollar volume, plus SPY/QQQ |
| `~/.qlib/qlib_data/crypto_365` | ~150 MB | crypto, on a 365-day calendar |
| `webapp/ingest/.cache/` | ~4.4 GB | raw + normalised CSV scratch; keep it, `--mode update` reuses it |
| `webapp/data/market/` | ~540 MB | index/FX/crypto parquet that qlib itself never reads |
| `webapp/data/catalog.json` | ~900 KB | ticker → name/class/exchange; **without it, search matches tickers only** |

`~/.qlib` lives outside the repo and is shared with the host via the
`${HOME}/.qlib` mount, so a host-side venv and the containers use one dataset.

EODHD rate-limits; the client backs off on 429 (`webapp/ingest/eodhd.py`). A
partial ingest is resumable — rerun with `--skip-existing`.

`build_stores` is offline: it rebuilds both qlib stores, the universe files, and
`store_manifest.json` from the cached CSVs, so you can re-run it after a schema
change without spending quota.

## 8. Start it

```bash
docker compose up -d api ui
```

| Service | URL | Notes |
|---|---|---|
| UI | <http://localhost:5274> | 5173/5273 were taken on the original machine; the port is `strictPort` |
| API | <http://localhost:8770> | `/api/health`, OpenAPI at `/docs` |
| JupyterLab | <http://localhost:8888/lab?token=qlib> | `docker compose up -d jupyter` |
| MLflow | <http://localhost:5500> | `docker compose up -d mlflow-ui` |

Everything except MLflow binds `127.0.0.1` only. There is no auth — the API keys
stay server-side and never reach the browser.

MLflow is published on 5500 because macOS ControlCenter owns 5000. On Linux 5000
is usually free, but the mapping is kept so both machines match.

## 9. Verify

```bash
curl -fsS localhost:8770/api/health && echo OK
docker compose exec api python -m pytest webapp/api/tests/ -q   # ~1100 tests
docker compose exec ui npm run test:unit                        # ~1100 tests
```

Then the end-to-end check that actually matters: open the UI, build a strategy in
the Builder, and run one short backtest. It should reach `succeeded` and show a
cumulative-return chart. That exercises the store, the `qrun` subprocess, and the
MLflow file store in one go — the three things most likely to be misconfigured.

## 10. Bare-metal alternative (no Docker)

Needs Python 3.11, `build-essential`, `libgomp1` (LightGBM's OpenMP runtime),
Node 22, and ideally [uv](https://docs.astral.sh/uv/).

```bash
sudo apt install -y build-essential libgomp1 python3.11 python3.11-venv
./scripts/setup-venv.sh
./webapp/dev.sh both
```

`setup-venv.sh` creates `.venv`, compiles the Cython extensions, installs qlib
plus `webapp/requirements.txt`, and writes the MLflow `.pth` described in §11.
Data still comes from §7 — drop the `docker compose run --rm qlib` prefix and use
`.venv/bin/python` instead.

## 11. Things that will bite you

**`ImportError` on `qlib.data._libs.rolling`.** The rolling/expanding operators
are Cython and `qlib/data/ops.py` re-raises with no pure-Python fallback, so this
is fatal rather than slow. In Docker, `docker/qlib-entrypoint.sh` rebuilds them
into the bind mount on first start — the mount hides the ones baked into the
image, and macOS `.so` files can't load on Linux anyway. Bare-metal, it's
`make prerequisite` (which `setup-venv.sh` runs).

**MLflow refuses to open the store.** mlflow ≥ 3.14 needs
`MLFLOW_ALLOW_FILE_STORE=true`, and AION's tracking store is a file store at
`examples/mlruns`. It is set in the image (`Dockerfile.dev`) and for every `qrun`
subprocess (`webapp/api/runner.py`), but a bare `qrun`, a notebook, or `R.start()`
in a hand-rolled venv will fail without the `.pth` that `setup-venv.sh` writes.

**503 from every data endpoint.** `~/.qlib/qlib_data` is empty — see §7.

**Backtests fail with an exec error.** `RunManager` runs `qrun` as a subprocess and
picks the interpreter via `default_python` (`webapp/api/runner.py`): the repo's
`.venv/bin/python` if it is present *and* executable, otherwise `sys.executable`.
Containers therefore use their own Python, since a host venv on the bind mount is
either a dangling symlink or a foreign binary. If you are running Docker on Linux
*and* keep a working Linux `.venv` in the repo, the container will prefer it — set
`AION_IMAGE` and remove the host venv if that mixes environments badly.

**Port already in use.** 5274 is `strictPort` in `vite.config.ts` — Vite fails
rather than silently moving. Note that a host-side `./webapp/dev.sh` already
holding 8770 will make `docker compose up api` fail to bind while
`curl localhost:8770` still answers — from the *host* process. Stop one or the
other before concluding the container is healthy.

**A run fails with exit code `-9` and no traceback.** That is SIGKILL, i.e. the
container hit its memory ceiling — not a missing dependency, whatever the run's
`error_hint` says (the hint is a log-scraping heuristic and will happily blame
PyTorch for an OOM). Raise Docker's memory or use a smaller universe.

**Linear models produce empty results.** A known pre-existing issue: custom factor
expressions can emit infinities, and `scipy.linalg.solve` rejects them. Alpha158's
default `infer_processors` is empty in the custom handler, so nothing sanitises
them. Unrelated to setup.

## 12. What deliberately does not come across

Not bugs — these are excluded on purpose, and the app rebuilds them or does
without:

| | Why |
|---|---|
| `examples/mlruns/` (~463 MB) | Its `artifact_location` URIs are absolute to the original machine. Not relocatable without rewriting 116 files; new runs start a clean store. |
| `webapp/data/runs/` | Run records point at those MLflow artifacts. |
| `webapp/data/catalog.json`, `store_manifest.json` | Ingest output. A stale catalog names tickers your store doesn't have, which is worse than none. |
| `webapp/ingest/.cache/`, `webapp/data/market/` | ~5 GB, regenerated by §7. |
| `.venv/`, `node_modules/` | Platform-specific; rebuilt by `setup-venv.sh` / `npm install`. |

`webapp/data/strategies/` and `webapp/data/portfolios/` **are** committed — they
are hand-authored, not generated, so the demo content is there on first boot.

---

Further reading: [`webapp/README.md`](webapp/README.md) for how the app is put
together and the data-correctness decisions behind the ingest.
