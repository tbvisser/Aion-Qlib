"""What columns a store actually holds.

This exists because of one silent failure. ``FileFeatureStorage`` returns an
empty series for a column whose ``.bin`` file is missing rather than raising, so
an expression naming ``$vwap`` against a store built without it evaluates to NaN
at every row -- through ``D.features``, through the handler, through the whole
backtest -- and the first sign of trouble is a model that trains on nothing.

Alpha158 names ``$vwap`` in five of its 184 indicators and Alpha360 names it
sixty times, so the census is not a nicety; it is the difference between
offering a library and offering a trap.

Read straight off the filesystem rather than through qlib, so it answers for the
stores the API process never mounted -- which is both of them, when nothing has
initialised qlib yet.

A column being *present* is also not the end of the question -- see
``PROXY_FIELDS``.
"""
from __future__ import annotations

import threading
from pathlib import Path

#: Columns that exist, but are not what their name promises.
#:
#: A present column is reported in ``fields`` and everything downstream treats
#: it as computable, which it is. That is the right answer for "will this
#: expression evaluate" and the wrong one for "what am I measuring", so the
#: difference is carried separately rather than folded into either.
#:
#: ``vwap`` is here because EODHD's end-of-day feed has no volume-weighted
#: price. Rather than leave the column absent -- which is silently fatal, see
#: the module docstring -- ``webapp.ingest.vwap`` writes typical price into it.
PROXY_FIELDS: dict[str, str] = {
    "vwap": (
        "This store's $vwap is typical price, (high + low + close) / 3, written "
        "at ingest as a stand-in. It is not an intraday volume-weighted price -- "
        "no source here carries one. Anything reading $vwap, including Alpha158's "
        "VWAP0 and Alpha360's sixty VWAP columns, is measuring typical price."
    ),
}

# Enough instruments to catch a column that exists for some names and not
# others, without stat-ing a 12,000-symbol store. The first directories in sort
# order are as arbitrary a sample as any, and the check is cheap enough that
# widening it later costs nothing.
_SAMPLE = 40

_lock = threading.Lock()
_cache: dict[tuple[str, float], dict] = {}


def census(provider_uri: str | Path) -> dict:
    """The columns present in a store, split by whether every name has them.

    ``fields``  present in every sampled instrument -- safe to name.
    ``partial`` present in some. An expression using one of these is not broken,
                but it silently drops the instruments that lack it, so it is
                reported separately rather than folded into either answer.

    Cached on the features directory's mtime. Forty instruments is a cheap
    sample, but reaching them means sorting the whole directory first, and that
    directory holds ten thousand entries. Lowering one draft calls this twice;
    the template gallery lowers thirty. Sorting three hundred thousand paths to
    answer a question whose answer changes only when an ingest runs was most of
    the gallery's response time.
    """
    features = Path(provider_uri).expanduser() / "features"
    try:
        key = (str(features), features.stat().st_mtime)
    except OSError:
        return {"fields": [], "partial": [], "instruments_sampled": 0, "exists": False}
    if not features.is_dir():
        return {"fields": [], "partial": [], "instruments_sampled": 0, "exists": False}

    with _lock:
        hit = _cache.get(key)
    if hit is not None:
        return dict(hit)

    sampled = 0
    everywhere: set[str] | None = None
    anywhere: set[str] = set()
    for entry in sorted(features.iterdir()):
        if not entry.is_dir():
            continue
        columns = {p.name.split(".")[0] for p in entry.glob("*.day.bin")}
        if not columns:
            continue
        anywhere |= columns
        everywhere = columns if everywhere is None else (everywhere & columns)
        sampled += 1
        if sampled >= _SAMPLE:
            break

    everywhere = everywhere or set()
    result = {
        "fields": sorted(everywhere),
        "partial": sorted(anywhere - everywhere),
        # Only the proxies this store actually has. Additive: every existing
        # reader takes `fields` and `partial` and is unaffected.
        "proxy": {f: PROXY_FIELDS[f] for f in sorted(everywhere) if f in PROXY_FIELDS},
        "instruments_sampled": sampled,
        "exists": sampled > 0,
    }

    with _lock:
        # Bounded: the working set is one entry per store, and clearing is
        # cheaper than tracking eviction for a cache this small.
        if len(_cache) > 16:
            _cache.clear()
        _cache[key] = result
    # Copied on the way out so a caller mutating the dict cannot poison the next
    # reader -- `library_payload` and friends treat it as theirs.
    return dict(result)
