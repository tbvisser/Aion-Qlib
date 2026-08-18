"""Settings for the scalability agent service.

Everything is environment-driven. Secrets come from the repo-root ``.env``
(gitignored) when running locally, or from the compose service's environment
in Docker -- never from committed source. The agent shares the Supabase
stack the webapp uses, but holds its own service-role credentials because it
is the only writer of job/report state and deliberately bypasses RLS.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

PACKAGE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = PACKAGE_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- external services --------------------------------------------------
    # Raw Postgres to the same Supabase database the platform uses. Unlike the
    # API (which connects as `authenticator` so RLS applies), the agent runs as
    # `service_role`: it outlives any user token and is the only writer of
    # job/report state, so bypassing RLS here is deliberate.
    database_url: str = ""
    # HTTP base of the Supabase stack, used only for the Storage REST API
    # (upload artifacts, download uploaded trade files).
    supabase_url: str = "http://host.docker.internal:8010"
    supabase_service_role_key: str = ""

    # --- worker tuning ------------------------------------------------------
    # Seconds between queue polls when no job was available. Polling (not
    # LISTEN/NOTIFY) matches the platform scheduler's existing style.
    agent_poll_seconds: float = 5
    # Jobs in flight per replica. Horizontal scale comes from adding replicas;
    # SKIP LOCKED makes double-claims impossible, so this stays small.
    agent_workers: int = 2
    # How long a claimed job may run before the reaper considers its worker
    # dead and requeues it.
    agent_lease_seconds: int = 120
    # How often the per-job heartbeat thread proves the worker is alive. Must
    # be comfortably below the lease or a slow heartbeat reads as a crash.
    agent_heartbeat_seconds: float = 30
    # Total attempts a job gets (initial try plus requeues) before it is
    # marked permanently failed.
    agent_max_attempts: int = 3
    # Port for the minimal /health HTTP server -- the only inbound surface
    # this service has, and only so compose can healthcheck it.
    agent_port: int = 8771


@lru_cache
def get_settings() -> Settings:
    return Settings()
