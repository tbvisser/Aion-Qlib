"""Write a `$vwap` column into a qlib store as typical price.

    .venv/bin/python -m webapp.ingest.vwap --store us
    .venv/bin/python -m webapp.ingest.vwap --store us --verify

**This is a proxy, and the whole module exists to say so honestly.** EODHD's
end-of-day feed carries no volume-weighted price, so `(high + low + close) / 3`
-- "typical price" -- is written instead. It is not a VWAP. Anything reading
`$vwap` on these stores is reading typical price, and every surface that offers
such a column repeats that sentence (`factorlab.stores.PROXY_FIELDS`).

Why write it at all, rather than leaving the column absent:

`FileFeatureStorage` returns an *empty series* for a missing `.bin` rather than
raising. Alpha158 names `$vwap` once (`VWAP0`) and Alpha360 names it sixty
times, so on a store without the column those are all-NaN -- silently, through
the handler, through training, through the whole backtest. `LinearModel.fit`
calls `df_train.dropna()` across every feature, so a single all-NaN column drops
*every* row and the run dies with "Empty data from dataset". A proxy that is
approximately right beats a column that is exactly absent.

The DropCol mitigation in `strategies.py` stays regardless: a fresh install, a
store this pass has not been run against, and a half-finished pass all still
need it.

### The file format

`scripts/dump_bin.py` writes one little-endian float32 header holding the index
into `calendars/day.txt` of the instrument's first bar, then one float32 per
calendar day through its last. Every field of an instrument is dumped from the
same frame, so they share a header and a length -- which is what makes this pass
additive: read three siblings, write a fourth beside them, touch nothing else.

A wrong header is the one failure that cannot be detected downstream: it shifts
the whole series against the calendar, and every value stays plausible. So a
header is never reconstructed or assumed. If the three inputs disagree, the
instrument is skipped and counted.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

#: The fields typical price is computed from, in the order they are averaged.
SOURCE_FIELDS = ("high", "low", "close")

FIELD = "vwap"
SUFFIX = ".day.bin"


def _read(path: Path) -> np.ndarray:
    return np.fromfile(path, dtype="<f4")


def _instrument_dirs(features: Path):
    for entry in sorted(features.iterdir()):
        if entry.is_dir():
            yield entry


def typical_price(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    """`(high + low + close) / 3` over the value region, header preserved.

    NaN propagates: a day with no high has no typical price, which matches what
    `close` itself already does on that day. Filling it would invent a bar.
    """
    values = (high[1:].astype(np.float64)
              + low[1:].astype(np.float64)
              + close[1:].astype(np.float64)) / 3.0
    return np.hstack([close[:1], values.astype("<f4")]).astype("<f4")


def write_vwap_proxy(
    qlib_dir: Path | str, *, overwrite: bool = False, verify: bool = False,
) -> dict:
    """Add `vwap.day.bin` beside every instrument's `close.day.bin`.

    `verify=True` reads and checks without writing anything, which is the only
    honest way to confirm a pass finished: `census` samples the first forty
    instruments in sort order, so a run that died half way through an
    alphabetical walk looks complete to it.
    """
    features = Path(qlib_dir).expanduser() / "features"
    if not features.is_dir():
        raise FileNotFoundError(f"no features directory under {qlib_dir}")

    written = skipped = present = 0
    mismatched: list[str] = []
    missing_source: list[str] = []

    for entry in _instrument_dirs(features):
        target = entry / f"{FIELD}{SUFFIX}"
        if target.exists() and not (overwrite or verify):
            present += 1
            continue

        paths = [entry / f"{f}{SUFFIX}" for f in SOURCE_FIELDS]
        if not all(p.exists() for p in paths):
            missing_source.append(entry.name)
            skipped += 1
            continue

        high, low, close = (_read(p) for p in paths)

        # Never reconstruct a header. A series written against the wrong start
        # index is shifted against the calendar and every value still looks
        # like a price -- the one corruption nothing downstream can catch.
        headers = {float(a[0]) for a in (high, low, close)}
        lengths = {len(a) for a in (high, low, close)}
        if len(headers) != 1 or len(lengths) != 1 or len(close) < 2:
            mismatched.append(entry.name)
            skipped += 1
            continue

        if verify:
            if not target.exists():
                mismatched.append(entry.name)
                skipped += 1
            else:
                existing = _read(target)
                expected = typical_price(high, low, close)
                if existing.shape != expected.shape or not np.allclose(
                    existing, expected, equal_nan=True, rtol=1e-5, atol=1e-6,
                ):
                    mismatched.append(entry.name)
                    skipped += 1
                else:
                    present += 1
            continue

        # Written to a sibling and renamed. A torn `.bin` is a real column full
        # of garbage, which no census can distinguish from a good one; a missing
        # column is a case everything downstream already handles.
        tmp = target.with_suffix(target.suffix + ".tmp")
        typical_price(high, low, close).tofile(tmp)
        os.replace(tmp, target)
        written += 1

    if written:
        # `census` keys its cache on this directory's own mtime, and writing
        # files *inside* the per-instrument directories does not move it. Without
        # this the new column is invisible to a running API until it restarts —
        # which is the whole fix silently not landing.
        os.utime(features)

    return {
        "store": str(Path(qlib_dir).expanduser()),
        "written": written,
        "already_present": present,
        "skipped": skipped,
        "mismatched": mismatched,
        "missing_source": missing_source,
        "total": written + present + skipped,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="webapp.ingest.vwap", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--store", choices=("us", "crypto_365"),
                        help="a configured store, resolved through settings")
    target.add_argument("--qlib-dir", type=Path, help="a store directory directly")
    parser.add_argument("--overwrite", action="store_true",
                        help="recompute even where vwap.day.bin already exists")
    parser.add_argument("--verify", action="store_true",
                        help="check every instrument without writing anything")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    if args.qlib_dir:
        qlib_dir = args.qlib_dir
    else:
        from webapp.api.config import get_settings

        settings = get_settings()
        qlib_dir = Path(
            settings.provider_uri if args.store == "us" else settings.crypto_provider_uri
        ).expanduser()

    try:
        report = write_vwap_proxy(qlib_dir, overwrite=args.overwrite, verify=args.verify)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    verb = "would need writing" if args.verify else "written"
    logger.info("%s: %d %s, %d already present, %d skipped of %d",
                report["store"], report["written"], verb,
                report["already_present"], report["skipped"], report["total"])
    for name, symbols in (("header/length mismatch", report["mismatched"]),
                          ("missing high/low/close", report["missing_source"])):
        if symbols:
            shown = ", ".join(symbols[:10])
            more = f" (+{len(symbols) - 10} more)" if len(symbols) > 10 else ""
            logger.warning("%d skipped for %s: %s%s", len(symbols), name, shown, more)

    if args.verify and report["skipped"]:
        print(f"error: {report['skipped']} instruments are not covered", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
