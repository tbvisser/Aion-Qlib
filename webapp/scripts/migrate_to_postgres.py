"""Move the file-based strategies, portfolios, projects and runs into Postgres.

One-off, and idempotent: every record is written at its existing id, so a second
run updates rather than duplicating. Safe to re-run after a partial failure.

Everything is assigned to a single owner and left private. That is a deliberate
choice rather than a shortcut -- these records were created before the app had
any notion of who was using it, so the only honest answer to "whose is this?" is
"the person who has been running it". Anything worth sharing can be shared
afterwards from the UI, which is one click and reversible; guessing here and
publishing someone's work to a whole organisation is neither.

Files are left exactly where they are. Verify the counts this prints, use the
app, and only then retire the directories -- there is no undo on the other side.

Usage, from the repo root::

    docker compose exec api python -m webapp.scripts.migrate_to_postgres --owner you@example.com
    docker compose exec api python -m webapp.scripts.migrate_to_postgres --owner you@example.com --apply

Without --apply it reports what it would do and writes nothing.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import yaml

from webapp.api.config import get_settings
from webapp.api.db import service_tx
from webapp.api.portfolios import PortfolioSpec
from webapp.api.projects import ProjectSpec
from webapp.api.strategies import StrategySpec


@dataclass
class Owner:
    user_id: str
    org_id: str
    email: str


def resolve_owner(email: str) -> Owner:
    """Find the account and organisation everything will be filed under.

    Reads auth.users as postgres rather than through the API, because this runs
    before anyone has signed in and there is no token to present.
    """
    with service_tx() as cur:
        # service_role has no SELECT on auth.users, so go via user_profiles,
        # which does carry the id, and match the email through the org the
        # signup trigger derived from it.
        cur.execute(
            "SELECT p.user_id, p.default_org_id, o.slug "
            "FROM public.user_profiles p "
            "JOIN public.organizations o ON o.id = p.default_org_id "
            "WHERE o.slug = %s OR p.user_id::text = %s",
            (email.split("@")[0].lower(), email),
        )
        row = cur.fetchone()
    if row is None:
        raise SystemExit(
            f"No account found for {email!r}. Sign in once through the UI so the "
            "signup trigger creates the profile and personal organisation, then "
            "re-run this."
        )
    return Owner(str(row["user_id"]), str(row["default_org_id"]), email)


def _iso(value) -> str:
    if isinstance(value, str) and value:
        return value
    return datetime.now(timezone.utc).isoformat()


def _upsert(cur, table: str, record_id: str, owner: Owner, name: str,
            spec: dict, created_at: str, updated_at: str) -> None:
    cur.execute(
        f"INSERT INTO aion.{table} "
        "  (id, org_id, user_id, visibility, name, spec, created_at, updated_at) "
        "VALUES (%s, %s, %s, 'private', %s, %s::jsonb, %s::timestamptz, %s::timestamptz) "
        "ON CONFLICT (id) DO UPDATE SET "
        "  name = EXCLUDED.name, spec = EXCLUDED.spec, updated_at = EXCLUDED.updated_at",
        (record_id, owner.org_id, owner.user_id, name, json.dumps(spec),
         created_at, updated_at),
    )


def migrate_specs(cur, directory: Path, table: str, model, loader, owner: Owner,
                  apply: bool) -> tuple[int, list[str]]:
    """Read every file in ``directory`` and write it as a row."""
    if not directory.is_dir():
        return 0, []
    count, skipped = 0, []
    suffix = "*.yaml" if loader is yaml.safe_load else "*.json"
    for path in sorted(directory.glob(suffix)):
        try:
            raw = loader(path.read_text(encoding="utf-8"))
            record_id = raw.get("id") or path.stem
            created = _iso(raw.get("created_at"))
            updated = _iso(raw.get("updated_at"))
            # Validate through the model, so a file the app could not have
            # loaded is not silently promoted into the database.
            spec = model(**{k: v for k, v in raw.items() if k in model.model_fields})
            payload = spec.model_dump(mode="json")
        except Exception as exc:  # noqa: BLE001 - reported per file
            skipped.append(f"{path.name}: {type(exc).__name__}: {exc}")
            continue
        if apply:
            _upsert(cur, table, record_id, owner, payload.get("name", record_id),
                    payload, created, updated)
        count += 1
    return count, skipped


def migrate_runs(cur, runs_dir: Path, owner: Owner, apply: bool) -> tuple[int, list[str]]:
    """Runs are directories holding run.json, config.yaml and run.log.

    Only run.json becomes a row. config.yaml and run.log stay on disk exactly
    where they are -- the runner still reads them from there, and the row is
    what decides who may.
    """
    if not runs_dir.is_dir():
        return 0, []

    lifecycle = {
        "id", "name", "kind", "strategy_id", "status", "phase", "exit_code",
        "error", "error_hint", "experiment_name", "metrics",
        "created_at", "started_at", "finished_at",
    }
    count, skipped = 0, []
    for directory in sorted(p for p in runs_dir.iterdir() if p.is_dir()):
        meta_path = directory / "run.json"
        if not meta_path.exists():
            skipped.append(f"{directory.name}: no run.json")
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            run_id = meta.get("id") or directory.name
            status = meta.get("status") or "failed"
            if status not in ("queued", "running", "succeeded", "failed", "cancelled"):
                status = "failed"
            # An old record still claiming to be in flight belongs to a process
            # that is long gone. Import it settled rather than resurrect a
            # spinner that will never stop.
            if status in ("queued", "running"):
                status = "failed"
            params = {k: v for k, v in meta.items() if k not in lifecycle}
        except Exception as exc:  # noqa: BLE001
            skipped.append(f"{directory.name}: {type(exc).__name__}: {exc}")
            continue

        if apply:
            cur.execute(
                "INSERT INTO aion.runs (id, org_id, user_id, visibility, name, kind, "
                "  strategy_id, status, phase, exit_code, error, error_hint, "
                "  experiment_name, params, metrics, created_at, started_at, finished_at) "
                "VALUES (%s, %s, %s, 'private', %s, %s, %s, %s, %s, %s, %s, %s, %s, "
                "  %s::jsonb, %s::jsonb, %s::timestamptz, %s::timestamptz, %s::timestamptz) "
                "ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, "
                "  phase = EXCLUDED.phase, metrics = EXCLUDED.metrics, "
                "  params = EXCLUDED.params, updated_at = NOW()",
                (run_id, owner.org_id, owner.user_id, meta.get("name") or run_id,
                 meta.get("kind") or "backtest", meta.get("strategy_id"), status,
                 meta.get("phase"), meta.get("exit_code"), meta.get("error"),
                 meta.get("error_hint"), meta.get("experiment_name"),
                 json.dumps(params), json.dumps(meta.get("metrics")),
                 _iso(meta.get("created_at")), meta.get("started_at"),
                 meta.get("finished_at")),
            )
        count += 1
    return count, skipped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", required=True,
                        help="Email of the account to file every record under.")
    parser.add_argument("--apply", action="store_true",
                        help="Actually write. Without it, nothing is changed.")
    args = parser.parse_args()

    settings = get_settings()
    owner = resolve_owner(args.owner)
    print(f"Owner: {args.owner}  user={owner.user_id}  org={owner.org_id}")
    print("Mode : " + ("APPLY (writing)" if args.apply else "DRY RUN (no writes)"))
    print()

    all_skipped: list[str] = []
    with service_tx() as cur:
        n_strat, s1 = migrate_specs(cur, settings.strategies_dir, "strategies",
                                    StrategySpec, yaml.safe_load, owner, args.apply)
        n_port, s2 = migrate_specs(cur, settings.portfolios_dir, "portfolios",
                                   PortfolioSpec, json.loads, owner, args.apply)
        n_proj, s3 = migrate_specs(cur, settings.projects_dir, "projects",
                                   ProjectSpec, json.loads, owner, args.apply)
        n_runs, s4 = migrate_runs(cur, settings.runs_dir, owner, args.apply)
        all_skipped = s1 + s2 + s3 + s4
        # No rollback needed for a dry run: `apply` gates every write, so the
        # counts above come from parsing files, not from writing and undoing.

    print(f"  strategies  {n_strat}")
    print(f"  portfolios  {n_port}")
    print(f"  projects    {n_proj}")
    print(f"  runs        {n_runs}")

    if all_skipped:
        print(f"\nSkipped {len(all_skipped)} unreadable file(s):")
        for line in all_skipped:
            print(f"  - {line}")

    if args.apply:
        print("\nVerifying by reading back:")
        with service_tx() as cur:
            for table in ("strategies", "portfolios", "projects", "runs"):
                cur.execute(
                    f"SELECT count(*) AS n FROM aion.{table} WHERE user_id = %s",
                    (owner.user_id,))
                print(f"  aion.{table:<11} {cur.fetchone()['n']} row(s) owned by {args.owner}")
        print("\nFiles are untouched. Retire them only once the app looks right.")
    else:
        print("\nNothing was written. Re-run with --apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
