"""The factor vocabulary, read out of qlib rather than transcribed from it.

Two authorities live here, and both are pure Python that needs no store:

``operators``   ``qlib.data.ops.OpsList`` -- what the expression language can say.
``indicators``  ``Alpha158DL.get_feature_config`` -- what it has already said.

qlib is imported at module top level in this package, unlike ``strategy_gen``,
because neither authority touches the provider: ``OpsList`` is a list of classes
and ``get_feature_config`` is string manipulation. So the registry, the library
and their drift tests all run on a machine that has never built a store. Only
*evaluating* an expression needs data, and that stays in the routers.
"""
from __future__ import annotations
