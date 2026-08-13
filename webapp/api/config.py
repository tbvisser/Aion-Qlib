"""Settings for the qlib web API.

Secrets come from ``webapp/.env`` (gitignored) or the process environment --
never from committed source. See ``webapp/.env.example`` for the shape.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

WEBAPP_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = WEBAPP_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=WEBAPP_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- data ---------------------------------------------------------------
    # The qlib binary store the API serves. Defaults to the EODHD US store the
    # ingest pipeline builds; the bundled CN dataset stays untouched at
    # ~/.qlib/qlib_data/cn_data so the benchmarks remain reproducible.
    provider_uri: str = "~/.qlib/qlib_data/us_eodhd"
    region: str = "us"
    # Fallback used until the US store exists, so the app is useful immediately.
    fallback_provider_uri: str = "~/.qlib/qlib_data/cn_data"
    fallback_region: str = "cn"
    # Crypto on its own 365-day calendar. A separate store because qlib keeps
    # one calendar per store, and equities have no bars on a Sunday. Backtests
    # reach it by provider_uri in the generated workflow YAML -- qrun runs as a
    # subprocess, so it is free to init on a different store than the API did.
    crypto_provider_uri: str = "~/.qlib/qlib_data/crypto_365"

    # --- external services --------------------------------------------------
    eodhd_api_key: str = ""
    openrouter_api_key: str = ""
    openrouter_model: str = "anthropic/claude-sonnet-5"
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    # Vibe-Trading sidecar (compose services vibe-api / vibe-mcp). The token
    # must equal API_AUTH_KEY in vibe/.env: vibe rejects non-loopback callers
    # without it, and this API reaches it over the docker network. Empty token
    # means the proxy runs unauthenticated (works only for native dev where
    # both processes share localhost).
    vibe_api_url: str = "http://vibe-api:8000"
    vibe_mcp_url: str = "http://vibe-mcp:8900/mcp"
    vibe_api_token: str = ""
    # The vendored Aion-RAG backend (compose service rag-api). This API reaches
    # it for one thing only: the unauthenticated capability listings at
    # /registry/*, which the Agents & Skills page federates. Everything else it
    # serves is per-user behind a Supabase JWT and stays a browser concern --
    # see webapp/api/registry/providers/rag_registry.py.
    rag_api_url: str = "http://rag-api:8001"

    # --- identity and per-user storage --------------------------------------
    # The same Supabase the RAG half already uses (compose project supabase-aq,
    # in-repo at infra/supabase/). Two distinct connections to it, for two
    # distinct jobs:
    #
    # supabase_url is HTTP, and is used only to fetch the JWKS that verifies
    # access tokens. supabase_anon_key accompanies that fetch; it is public by
    # design. The service role key is NOT needed here -- this API never calls
    # PostgREST -- but is read so a future admin path has it in one place.
    supabase_url: str = "http://host.docker.internal:8010"
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    # database_url is raw Postgres, and is how every user record is read and
    # written. It must connect as `authenticator`: that role cannot bypass RLS,
    # which is the entire point. Connecting as `postgres` would silently defeat
    # every policy in the aion schema, because superusers are exempt.
    #
    # The api service joins the supabase-aq_default network so it can reach the
    # database container directly, rather than going out through the supavisor
    # pooler and inheriting its user.tenant username form.
    database_url: str = ""
    # Pool bounds. Small on purpose: this is one uvicorn worker serving a team,
    # not a public site, and every connection held here is one the rest of the
    # Supabase stack cannot use.
    db_pool_min: int = 1
    db_pool_max: int = 8

    # --- local paths --------------------------------------------------------
    strategies_dir: Path = WEBAPP_DIR / "data" / "strategies"
    runs_dir: Path = WEBAPP_DIR / "data" / "runs"
    # Staging area for the normalized per-symbol CSVs the ingest writes before
    # dumping them to the binary store. Kept out of the store itself so a
    # failed dump leaves the previous store intact.
    us_csv_dir: Path = WEBAPP_DIR / "ingest" / ".cache" / "csv"
    # Chart-only store for assets that do not share the .US trading calendar
    # (crypto trades 365 days a year, and mixing that into the qlib store either
    # loses its weekends or corrupts the equity calendar). Plain per-symbol
    # parquet -- qlib never reads it.
    market_dir: Path = WEBAPP_DIR / "data" / "market"
    # Ticker -> name/class/exchange/store, written by the ingest. Without it the
    # UI can only search tickers, so "apple" finds nothing.
    catalog_path: Path = WEBAPP_DIR / "data" / "catalog.json"
    # The searchable index over every collection the Database page browses.
    # Derived, never authoritative: deleting it costs one POST /api/catalog/
    # reindex, which is why it lives under the gitignored data/ dir beside the
    # stores it indexes rather than in the repo.
    catalog_db_path: Path = WEBAPP_DIR / "data" / "catalog.db"
    # qrun writes its MLflow file store relative to its working directory; runs
    # are launched from examples/ so they land in the same store the existing
    # qlib-mlflow-ui service already serves.
    mlflow_dir: Path = REPO_ROOT / "examples" / "mlruns"

    # --- macro & portfolios -------------------------------------------------
    # Cached EODHD macro (the economic calendar and the annual country
    # indicators) and saved portfolios. Both under data/, which is gitignored,
    # so both are per-machine and rebuilt rather than committed.
    macro_dir: Path = WEBAPP_DIR / "data" / "macro"
    portfolios_dir: Path = WEBAPP_DIR / "data" / "portfolios"
    projects_dir: Path = WEBAPP_DIR / "data" / "projects"

    # A GET never fetches. These only decide when a read path calls its own
    # cache stale in the response -- actuals land through the day, so the
    # calendar goes stale quickly; the indicators are annual data.
    macro_calendar_ttl_hours: int = 6
    macro_indicator_ttl_days: int = 7

    # How many sessions a macro print may be carried forward before the day is
    # reported missing rather than stale. Beyond it the value is null, never a
    # stale level dressed up as an observation.
    macro_ffill_limit: int = 5

    # A release timestamped after this UTC hour belongs to the next session.
    # Makes the event-study mapping an explicit rule instead of an accident.
    macro_session_shift_hour: int = 20

    # Comma strings, not lists: pydantic-settings JSON-parses a `list[str]`
    # field from the environment, so MACRO_EVENT_COUNTRIES=US,DE would fail to
    # load with a JSONDecodeError before the app ever starts.
    # ISO-2 for /economic-events, ISO-3 for /macro-indicator -- EODHD wants
    # different code systems on the two endpoints.
    macro_event_countries: str = "US,DE,GB,JP,CN"
    macro_indicator_countries: str = "USA,DEU,GBR,JPN,CHN"

    @property
    def repo_root(self) -> Path:
        return REPO_ROOT

    @property
    def event_countries(self) -> list[str]:
        return [c.strip().upper() for c in self.macro_event_countries.split(",") if c.strip()]

    @property
    def indicator_countries(self) -> list[str]:
        return [c.strip().upper() for c in self.macro_indicator_countries.split(",") if c.strip()]


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.strategies_dir.mkdir(parents=True, exist_ok=True)
    settings.runs_dir.mkdir(parents=True, exist_ok=True)
    settings.macro_dir.mkdir(parents=True, exist_ok=True)
    settings.portfolios_dir.mkdir(parents=True, exist_ok=True)
    settings.projects_dir.mkdir(parents=True, exist_ok=True)
    return settings
