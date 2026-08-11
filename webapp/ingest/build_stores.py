"""Build both qlib stores and their universe files from cached CSVs.

    .venv/bin/python -m webapp.ingest.build_stores --all

Nothing here hits the network: it reorganises bars the ingest already
downloaded. Safe to re-run.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from webapp.api.config import get_settings
from webapp.ingest import stores
from webapp.ingest.eodhd import (
    ASSET_CLASSES, _write_vwap_proxy, dump_to_qlib, read_calendar, write_future_calendar,
)
from webapp.ingest.vwap import write_vwap_proxy

logger = logging.getLogger(__name__)

# Classes whose bars live outside the main store until promoted.
MARKET_CLASSES = ("crypto", "fx", "index")
TOP_N = {"crypto": 100, "etf": 100, "fx": 50, "index": 50}
# Cross-asset universe: the most liquid names of each class together, for
# strategies that trade across classes rather than within one.
CROSS_ASSET_NAME = "macro50"
CROSS_ASSET_PER_CLASS = {"equity": 20, "etf": 10, "crypto": 10, "index": 5, "fx": 5}


def _class_symbols(catalog: dict, cls: str) -> list[str]:
    return [e["s"] for e in catalog["symbols"] if e["c"] == cls]


def _reconstruct_manifest(cache_root: Path, catalog: dict) -> dict[str, list[str]]:
    """Work out which class owns each promoted ticker, without re-promoting.

    Replays the same first-claimant rule ``promote_to_qlib`` applies: equities
    and ETFs were in the store first, then each market class in order. Needed
    because a second promote run would see every CSV already present and report
    the whole world as a collision.
    """
    claimed = {s.upper() for cls in ("equity", "etf") for s in _class_symbols(catalog, cls)}
    manifest: dict[str, list[str]] = {}
    for cls in MARKET_CLASSES:
        src = cache_root / cls
        owned: list[str] = []
        for symbol in _class_symbols(catalog, cls):
            if symbol.upper() in claimed:
                continue
            if not (src / f"{symbol}.csv").exists():
                continue
            owned.append(symbol)
            claimed.add(symbol.upper())
        manifest[cls] = owned
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="webapp.ingest.build_stores", description=__doc__)
    parser.add_argument("--promote", action="store_true",
                        help="rebase+clip crypto/fx/index into the main store and re-dump")
    parser.add_argument("--crypto-store", action="store_true",
                        help="build the standalone 365-day crypto store")
    parser.add_argument("--universes", action="store_true", help="write universe files")
    parser.add_argument("--vwap", action="store_true",
                        help="write the derived $vwap column into both stores")
    parser.add_argument("--all", action="store_true", help="all four, in order")
    args = parser.parse_args(argv)

    if args.all:
        args.promote = args.crypto_store = args.universes = args.vwap = True
    if not (args.promote or args.crypto_store or args.universes or args.vwap):
        parser.error("nothing to do — pass --all or one of the step flags")

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    qlib_dir = Path(settings.provider_uri).expanduser()
    csv_dir = Path(settings.us_csv_dir).expanduser()
    cache_root = csv_dir.parent
    catalog = json.loads(Path(settings.catalog_path).expanduser().read_text())
    report: dict = {}

    if args.promote:
        calendar = read_calendar(qlib_dir)
        if not calendar:
            print("error: main store has no calendar to clip to", file=sys.stderr)
            return 1
        promoted = stores.promote_to_qlib(
            {cls: cache_root / cls for cls in MARKET_CLASSES}, csv_dir, calendar
        )
        # Persist which symbols each class actually owns in the main store.
        # Universe files must be built from this, not from the catalog: a
        # ticker claimed by two classes only has one asset's bars in the store.
        manifest_path = Path(settings.catalog_path).expanduser().parent / "store_manifest.json"
        manifest_path.write_text(json.dumps(promoted, indent=2))
        report["promoted"] = {k: len(v) for k, v in promoted.items()}
        logger.info("re-dumping the main store with %d CSVs", len(list(csv_dir.glob("*.csv"))))
        dump_to_qlib(csv_dir, qlib_dir, settings.repo_root, mode="all")
        _write_vwap_proxy(qlib_dir, overwrite=True)
        write_future_calendar(qlib_dir)

    if args.crypto_store:
        crypto_dir = Path(settings.crypto_provider_uri).expanduser()
        report["crypto_store"] = stores.build_standalone_store(
            src_csv_dir=cache_root / "crypto",
            staging_dir=cache_root / "crypto_qlib",
            qlib_dir=crypto_dir,
            repo_root=settings.repo_root,
        )

    if args.vwap:
        # A step of its own because it is purely additive: it reads high/low/close
        # and writes one sibling file, so it can be run against stores built
        # before this step existed without re-dumping anything.
        #
        # `overwrite` only when this same invocation just re-dumped the bars —
        # otherwise a re-run would rewrite ten thousand identical files.
        vwap_report: dict[str, dict] = {}
        for key, path, redumped in (
            ("us", qlib_dir, args.promote),
            ("crypto_365", Path(settings.crypto_provider_uri).expanduser(), args.crypto_store),
        ):
            if not (path / "features").is_dir():
                logger.info("%s: no features directory, skipping $vwap", key)
                continue
            result = write_vwap_proxy(path, overwrite=redumped)
            vwap_report[key] = {"written": result["written"],
                                "already_present": result["already_present"],
                                "skipped": result["skipped"]}
            logger.info("%s $vwap: %d written, %d already present, %d skipped of %d",
                        key, result["written"], result["already_present"],
                        result["skipped"], result["total"])
        report["vwap"] = vwap_report

    if args.universes:
        written: dict[str, int] = {}
        ranked_cache: dict[str, list[str]] = {}
        manifest_path = Path(settings.catalog_path).expanduser().parent / "store_manifest.json"
        if not manifest_path.exists():
            manifest_path.write_text(json.dumps(_reconstruct_manifest(cache_root, catalog), indent=2))
        manifest = json.loads(manifest_path.read_text())

        for cls in ASSET_CLASSES:
            # Promoted classes: only the symbols that actually own their ticker
            # in the main store. Equities/ETFs were written by their own ingest
            # and so already own theirs.
            symbols = manifest.get(cls) or _class_symbols(catalog, cls)
            if not symbols:
                continue
            # Full class universe.
            if cls != "equity":  # equities already have top500/all
                written[cls] = stores.write_universe_file(qlib_dir, cls, csv_dir, symbols)
            # Liquid top-N: the long illiquid tail adds runtime and noise, not signal.
            ranked = sorted(symbols, key=lambda s: stores.dollar_volume(csv_dir, s), reverse=True)
            ranked_cache[cls] = ranked
            n = TOP_N.get(cls)
            if n:
                written[f"{cls}_top{n}"] = stores.write_universe_file(
                    qlib_dir, f"{cls}_top{n}", csv_dir, ranked[:n]
                )

        cross: list[str] = []
        for cls, n in CROSS_ASSET_PER_CLASS.items():
            cross.extend(ranked_cache.get(cls, [])[:n])
        if cross:
            written[CROSS_ASSET_NAME] = stores.write_universe_file(
                qlib_dir, CROSS_ASSET_NAME, csv_dir, cross
            )

        # The crypto store gets its own, ranked on its own bars.
        crypto_dir = Path(settings.crypto_provider_uri).expanduser()
        if crypto_dir.is_dir():
            staging = cache_root / "crypto_qlib"
            csyms = _class_symbols(catalog, "crypto")
            cranked = sorted(csyms, key=lambda s: stores.dollar_volume(staging, s), reverse=True)
            written["crypto_365:crypto"] = stores.write_universe_file(
                crypto_dir, "crypto", staging, csyms
            )
            written["crypto_365:crypto_top100"] = stores.write_universe_file(
                crypto_dir, "crypto_top100", staging, cranked[:100]
            )
        report["universes"] = written

    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
