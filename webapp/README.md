# AION

A web app over this qlib checkout: browse market data, test alpha factors, build
and backtest strategies, and drive all of it from a chat assistant. Styled from
the AION brand kit — see `ui/public/brand/`.

Nothing in `qlib/`, `scripts/` or `examples/` is modified — this is an additive
layer that calls the engine the same way the notebooks and benchmarks do.

## Running it

Setting this up on a fresh machine? Start with
[`ONBOARDING.md`](../ONBOARDING.md) — it covers the venv, the Docker stack, and
building the market data from scratch. Once that is done:

```bash
cp webapp/.env.example webapp/.env    # then fill in the two keys
./webapp/dev.sh both                  # API on :8770, UI on :5274
open http://localhost:5274
```

Or in Docker, alongside the rest of the stack:

```bash
docker compose up -d api ui
```

Both bind to `127.0.0.1` only. There is no auth: the EODHD and OpenRouter keys
live in the API process and never reach the browser.

## Layout

| Path | What it is |
|---|---|
| `api/` | FastAPI service. `routers/` are the HTTP surface; `strategies.py` turns a form into a qlib workflow config; `runner.py` executes runs; `results.py` reads MLflow artifacts. |
| `ingest/` | EODHD → normalized CSV → qlib binary store, via `scripts/dump_bin.py`. |
| `ui/` | React + Vite + TS frontend. |
| `data/` | Saved strategies and run records (gitignored). |

## Markov Chain Regime Analyzer

The **Markov Chains** page (`/lab/markov`) and the `get_markov_signal` chat tool
implement the observable Markov Chain regime framework:

- Label each day as **Bull / Bear / Sideways** from rolling returns.
- Estimate the transition matrix by counting state changes.
- Forecast regime probabilities at 1, 5, 12 and 24 steps via matrix powers
  (Chapman-Kolmogorov).
- Compute the stationary distribution.
- Generate a walk-forward trading signal and equity curve.

The model is deliberately simple: it makes the Markov property and time
homogeneity assumptions explicit, so the page is a starting point for regime
research rather than a production trading signal. A Hidden Markov Model
extension is planned as a second phase.

API endpoints:

- `GET /api/markov/analyze?symbol=SPY`
- `GET /api/markov/signal?symbol=SPY`
- `POST /api/markov/backtest`

## Market data

```bash
.venv/bin/python -m webapp.ingest --universe-size 500 --start 2010-01-01
```

Builds `~/.qlib/qlib_data/us_eodhd` from EODHD: the top N US common stocks by
recent dollar volume, plus SPY/QQQ as benchmarks. The bundled CN dataset is left
untouched, so the published benchmarks stay reproducible.

Three things the ingest gets right, each of which is a silent data bug otherwise:

- **Adjustment.** `factor = adjusted_close / close`, prices back-adjusted and
  rebased on the first close — qlib's convention, so `$close / $factor` returns
  the real traded price.
- **Returns across splits.** `change` comes from the *adjusted* series. EODHD's
  `close` is the raw traded price (unlike Yahoo's), so deriving returns from it
  prints −90% on NVDA's 2024 10:1 split instead of +0.75%.
- **The calendar.** Dates where almost no symbol traded are pruned. A few
  foreign listings print bars on US market holidays, and `dump_bin` unions all
  dates, so without this the calendar gains phantom sessions that shift every
  rolling window. A `day_future.txt` is also written — a backtest reaching the
  final bar still asks for the next day's timestamp.

## Notes

- Every backtest runs as a `qrun` subprocess. `qlib.init()` writes global state,
  so runs cannot share the API's process; this also means a crash in a native
  model can't take the server down.
- Runs write to `examples/mlruns`, the same store the `qlib-mlflow-ui` service
  serves, and each gets its own experiment (`aion-<run id>`; runs from before the rename use
  `qlibstudio-<run id>` and are still read).
- The API initialises qlib with `kernels=1`. qlib's default worker pool costs a
  flat ~14s per query in process startup — measured identical for 25 and 500
  instruments. Serially the same query takes under two seconds.
- Only models whose dependencies are installed are offered. The PyTorch
  benchmarks need the `rl` extras.

## Aion MCP (optional)

A streamable-HTTP MCP server exposes a read-only subset of chat tools for
[Hermes Agent](https://github.com/nousresearch/hermes-agent) and other MCP hosts.
See [`aion_mcp/README.md`](../aion_mcp/README.md). For the optional gateway
sidecar, see [`hermes/README.md`](../hermes/README.md). Set
`HERMES_GATEWAY_ENABLED=true` in `webapp/.env` when the gateway is running so
Agents & Skills shows the Hermes roster row and console card. Start MCP with:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d aion-mcp
```

## Tests

```bash
.venv/bin/python -m pytest webapp/api/tests/ -q
```
