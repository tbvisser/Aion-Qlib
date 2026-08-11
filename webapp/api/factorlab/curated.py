"""The curated factor library: named, documented expressions to build from.

This replaces a ten-entry Python list whose own comment said it was there "to
teach the expression language by example". The library is the databank a
strategy is actually assembled from, so it lives in YAML -- one file per family,
which is the unit a human edits and reviews, and the only place a family's own
prose has to live.

Three rules shape it.

**Every entry is a feature column by construction.** The name and expression are
validated by building a real ``strategies.FeatureColumn``, so the 40-character
cap, the identifier pattern and the ``LABEL`` prefix ban are inherited rather
than retyped -- and a curated factor is guaranteed droppable onto the canvas as
a column, which is exactly what the palette now does with it.

**A broken file is a load error, never a shorter list.** Same argument as
``load_templates``: a curated set that quietly shrinks is worse than one that
fails loudly. Four checks, all fatal -- it compiles, it has no defects, its name
is unique, and its name does not collide with a handler column. The last one is
the check nobody would think of and the one that silently destroys a feature
set: ``NestedDataLoader`` keeps the later duplicate, so a curated factor named
``MA20`` would delete Alpha158's ``MA20`` and the handler would come back the
same size.

**Store columns are checked when serving, never when loading.** The library is
repo data and must not become machine-dependent -- the same reason the UI
fixtures are store-independent. Whether a factor can run *here* is a flag on the
payload, alongside the ``$vwap`` note this module borrows from ``indicators``.

What could not be included, and why, is recorded in each family's
``description``: nothing cross-sectional (qlib evaluates one instrument at a
time, and its ``Rank`` is a rolling percentile, not a rank across the universe),
nothing recursive (Parabolic SAR, SuperTrend, KAMA), and no running totals
(cumulative OBV needs ``Sum(x, 0)``, which the defect check refuses).
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field

from .expressions import ExpressionError, compile_expression, inspect_expression
from .indicators import handler_columns

LIBRARY_DIR = Path(__file__).parent / "factor_library"

#: Palette order. Trend and momentum first because they are what people look
#: for; the anomalies last because they are the ones that need the most warm-up.
FAMILY_ORDER = ("trend", "momentum", "volatility", "volume", "candle", "anomaly")

_FIELD = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)")

#: Handlers whose column names a curated factor must not shadow.
_HANDLERS = ("Alpha158", "Alpha360")


class CuratedFactor(BaseModel):
    """One named expression, as it is written on disk."""

    model_config = ConfigDict(extra="forbid")

    name: str
    expression: str
    #: What it measures, in plain language. Never a performance claim.
    summary: str = Field(..., min_length=1)
    #: The lookback the name refers to, when it has one. Not derived -- `RSI_14`
    #: says 14 but smooths with an EWM whose true reach is much longer, and
    #: `back_days` already reports that separately.
    window: int | None = None
    tags: list[str] = Field(default_factory=list)
    #: A gotcha a user would otherwise discover from a wrong number.
    caveat: str | None = None


class FactorFamily(BaseModel):
    """One YAML file: a group of factors and the prose that frames them."""

    model_config = ConfigDict(extra="forbid")

    family: str = Field(..., pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
    label: str = Field(..., min_length=1)
    description: str = Field(..., min_length=1)
    factors: list[CuratedFactor] = Field(..., min_length=1)


class FactorLibraryError(ValueError):
    """A factor file that cannot be loaded. Never silently skipped."""


def _validate(factor: CuratedFactor, where: str, taken: dict[str, str]) -> None:
    """Everything that makes a curated factor safe to offer. All fatal."""
    from ..strategies import FeatureColumn

    try:
        # Inherits the name rules and the length caps rather than repeating them,
        # and proves the entry can be used as a feature column.
        FeatureColumn(name=factor.name, expression=factor.expression)
    except Exception as exc:  # noqa: BLE001 -- pydantic's detail is the message
        raise FactorLibraryError(f"{where}: {factor.name}: {exc}") from exc

    try:
        compile_expression(factor.expression)
    except ExpressionError as exc:
        raise FactorLibraryError(f"{where}: {factor.name}: {exc}") from exc

    # No available_fields on purpose: this is the repo-data check, and it must
    # give the same answer on a machine with no store built.
    defects = inspect_expression(factor.expression, role="feature")
    if defects:
        detail = "; ".join(d.message for d in defects)
        raise FactorLibraryError(f"{where}: {factor.name}: {detail}")

    if factor.name in taken:
        raise FactorLibraryError(
            f"{where}: {factor.name} is already defined in {taken[factor.name]}")

    for handler in _HANDLERS:
        if factor.name in handler_columns(handler):
            raise FactorLibraryError(
                f"{where}: {factor.name} collides with a {handler} column. "
                f"qlib's NestedDataLoader keeps the later duplicate, so this "
                f"factor would silently delete {handler}'s own {factor.name} "
                f"and the handler would come back the same size.")


@lru_cache(maxsize=1)
def load_families() -> tuple[FactorFamily, ...]:
    """Every shipped family, in palette order.

    Cached because the palette payload is built per request and the files never
    change at runtime; not fault-tolerant, because a family that vanishes after
    a typo is the failure mode a curated set must not have.
    """
    by_key: dict[str, FactorFamily] = {}
    taken: dict[str, str] = {}

    for path in sorted(LIBRARY_DIR.glob("*.yaml")):
        try:
            raw = yaml.safe_load(path.read_text())
        except yaml.YAMLError as exc:
            raise FactorLibraryError(f"{path.name}: {exc}") from exc
        if not isinstance(raw, dict):
            raise FactorLibraryError(f"{path.name}: expected a mapping")
        try:
            family = FactorFamily.model_validate(raw)
        except Exception as exc:  # noqa: BLE001 -- pydantic's detail is the message
            raise FactorLibraryError(f"{path.name}: {exc}") from exc

        if family.family in by_key:
            raise FactorLibraryError(f"{path.name}: duplicate family '{family.family}'")
        if family.family not in FAMILY_ORDER:
            raise FactorLibraryError(
                f"{path.name}: unknown family '{family.family}'. Add it to "
                f"FAMILY_ORDER, which decides palette order.")

        for factor in family.factors:
            _validate(factor, path.name, taken)
            taken[factor.name] = path.name

        by_key[family.family] = family

    missing = [key for key in FAMILY_ORDER if key not in by_key]
    if missing:
        raise FactorLibraryError(
            f"FAMILY_ORDER names {', '.join(missing)}, but no such file exists.")

    return tuple(by_key[key] for key in FAMILY_ORDER)


def all_factors() -> list[tuple[FactorFamily, CuratedFactor]]:
    """Every factor with the family it came from, in palette order."""
    return [(family, factor) for family in load_families() for factor in family.factors]


def fields_of(expression: str) -> list[str]:
    return sorted(set(_FIELD.findall(expression)))


def back_days(expression: str) -> int | None:
    """Trading days of history before this factor means anything.

    Worth serving because qlib's rolling uses ``min_periods=1``: ``Std($change,
    60)`` returns a confident number from two observations, while
    ``Ref($close, 252)`` is honestly NaN for a year. Nothing else distinguishes
    the two, and they can sit in the same feature set.
    """
    try:
        reach = compile_expression(expression).get_longest_back_rolling()
    except ExpressionError:
        return None
    return None if reach in (float("inf"), float("-inf")) else int(reach)


def _note(missing: list[str], name: str) -> str:
    columns = ", ".join(f"${m}" for m in missing)
    return (
        f"This store has no {columns} column. qlib returns an empty series for a "
        f"missing column rather than failing, so {name} would evaluate to NaN on "
        f"every row without an error anywhere."
    )


def curated_payload(provider_uri: str | None = None) -> dict:
    """The library, judged against one store.

    Without a store the shape is identical and every factor is reported as
    runnable-unknown rather than runnable -- the honest answer when there is
    nothing to check against.
    """
    from .stores import census

    available: set[str] | None = None
    partial: list[str] = []
    proxy: dict[str, str] = {}
    if provider_uri:
        found = census(provider_uri)
        if found["exists"]:
            available = set(found["fields"])
            partial = found["partial"]
            proxy = found.get("proxy", {})

    rows = []
    missing_columns: set[str] = set()
    for family, factor in all_factors():
        fields = fields_of(factor.expression)
        missing = (
            sorted(f for f in fields if f not in available)
            if available is not None else []
        )
        missing_columns |= set(missing)
        row = {
            "name": factor.name,
            "expression": factor.expression,
            "family": family.family,
            "summary": factor.summary,
            "window": factor.window,
            "tags": factor.tags,
            "fields": fields,
            "back_days": back_days(factor.expression),
            "runnable": None if available is None else not missing,
        }
        if factor.caveat:
            row["caveat"] = factor.caveat
        if missing:
            row["note"] = _note(missing, factor.name)
        rows.append(row)

    families = [
        {
            "key": family.family,
            "label": family.label,
            "description": family.description,
            "count": len(family.factors),
        }
        for family in load_families()
    ]

    return {
        "factors": rows,
        "families": families,
        "store": {
            "provider_uri": provider_uri,
            "checked": available is not None,
            "missing_columns": sorted(missing_columns),
            "partial_columns": partial,
            # Columns that exist but are not what their name promises. Distinct
            # from `missing_columns`: those break a factor, these change what it
            # means.
            "proxy_columns": proxy,
        },
    }
