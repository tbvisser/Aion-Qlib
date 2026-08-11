"""CLI for the EODHD -> qlib ingest.

    .venv/bin/python -m webapp.ingest --universe-size 500 --start 2010-01-01

Runs the same code path the API's /api/data/refresh endpoint uses, so a store
built from the terminal and one built from the UI are identical.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from webapp.api.config import get_settings
from webapp.ingest.eodhd import EodhdError, IngestProgress, run_ingest


def _print_progress(p: IngestProgress) -> None:
    line = f"[{p.stage}] {p.message}"
    if p.total:
        line += f" ({p.done}/{p.total})"
    print(line, flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="webapp.ingest", description=__doc__)
    parser.add_argument("--universe-size", type=int, default=500,
                        help="how many symbols, ranked by recent dollar volume")
    parser.add_argument("--start", default="2010-01-01", help="first bar date (YYYY-MM-DD)")
    parser.add_argument("--end", default=None, help="last bar date; omit for latest")
    parser.add_argument("--qlib-dir", default=None, help="output store; defaults to PROVIDER_URI")
    parser.add_argument("--csv-dir", default=None, help="staging dir for normalized CSVs")
    parser.add_argument("--max-workers", type=int, default=8)
    parser.add_argument("--mode", choices=("all", "update"), default="all",
                        help="'all' rebuilds the store; 'update' appends new bars")
    parser.add_argument("--classes", default=None,
                        help="comma-separated asset classes to ingest (equity,etf,crypto,fx,index). "
                             "Runs the multi-class pipeline instead of the equity-only one.")
    parser.add_argument("--limit", type=int, default=None,
                        help="cap symbols per class — for proving the pipeline before a full run")
    parser.add_argument("--skip-existing", action="store_true",
                        help="skip symbols whose CSV is already on disk (resume a failed run)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = get_settings()

    qlib_dir = Path(args.qlib_dir or settings.provider_uri).expanduser()
    csv_dir = Path(args.csv_dir or (Path(__file__).parent / ".cache" / "csv")).expanduser()

    if args.classes:
        from webapp.ingest.eodhd import ASSET_CLASSES, run_class_ingest

        classes = [c.strip() for c in args.classes.split(",") if c.strip()]
        unknown = [c for c in classes if c not in ASSET_CLASSES]
        if unknown:
            print(f"error: unknown class(es) {unknown}; known: {sorted(ASSET_CLASSES)}", file=sys.stderr)
            return 2
        try:
            summary = run_class_ingest(
                api_key=settings.eodhd_api_key,
                classes=classes,
                qlib_dir=qlib_dir,
                market_dir=Path(settings.market_dir).expanduser(),
                csv_dir=csv_dir,
                catalog_path=Path(settings.catalog_path).expanduser(),
                repo_root=settings.repo_root,
                start=args.start,
                end=args.end,
                max_workers=args.max_workers,
                limit=args.limit,
                skip_existing=args.skip_existing,
                on_progress=_print_progress,
            )
        except EodhdError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        print("\nDone:")
        print(json.dumps(summary, indent=2))
        return 0

    try:
        summary = run_ingest(
            api_key=settings.eodhd_api_key,
            qlib_dir=qlib_dir,
            csv_dir=csv_dir,
            repo_root=settings.repo_root,
            universe_size=args.universe_size,
            start=args.start,
            end=args.end,
            max_workers=args.max_workers,
            mode=args.mode,
            on_progress=_print_progress,
        )
    except EodhdError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print("\nDone:")
    for key, value in summary.items():
        print(f"  {key}: {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
