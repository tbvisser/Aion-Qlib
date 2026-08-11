"""What a strategy actually does, in the terms a reader would use.

Everything here is *derived*, never transcribed. The builder used to explain
itself with a hundred-line qrun YAML, which is precise and answers no question
anybody asked -- most of all "what is it predicting?", whose answer appears
nowhere in the UI at all.

The label is the sharp case. `Alpha158.get_label_config` returns

    Ref($close, -2) / Ref($close, -1) - 1

which is *not* a two-day forward return, though that is the usual shorthand. It
is the return from tomorrow's close to the next close: one session of exposure,
observed two days ahead. Writing "2-day return" in the UI would be a small lie
told confidently, so both numbers are computed and the wording keeps them apart.

Import-safe without qlib: `label_summary` catches everything and returns None,
because a preview must still render on a machine where qlib is not importable.
"""
from __future__ import annotations

import re

#: `Ref($close, -2)` -> -2. Only fields, never nested expressions: the label
#: configs are all of this shape, and a parser that handled more would be
#: guessing at what it had found.
_REF = re.compile(r"Ref\(\s*\$\w+\s*,\s*(-?\d+)\s*\)")


def label_summary(handler: str) -> dict | None:
    """The prediction target, as expression plus the two numbers that matter.

    ``horizon_days``  how far ahead the last observation sits. This is the
                      look-ahead the training window must not cross.
    ``holding_days``  how long the position is actually exposed -- the distance
                      between the two shifts. One, for both bundled handlers.

    ``None`` when qlib cannot answer, rather than a guess: the builder omits the
    sentence instead of stating a default that may be wrong.
    """
    try:
        from .factorlab.indicators import handler_label

        expressions, names = handler_label(handler)
    except Exception:  # noqa: BLE001 -- a preview must render without qlib
        return None

    if not expressions:
        return None

    expression = str(expressions[0])
    shifts = [int(m) for m in _REF.findall(expression)]
    horizon = max((abs(s) for s in shifts), default=None)
    # Two shifts means "from one date to another"; one means "from today".
    holding = abs(max(shifts) - min(shifts)) if len(shifts) >= 2 else horizon

    return {
        "expression": expression,
        "name": str(names[0]) if names else None,
        "horizon_days": horizon,
        "holding_days": holding,
    }
