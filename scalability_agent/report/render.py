"""Render a scalability result dict into a self-contained HTML report.

The report is the artifact the fund reads and -- only after the booking
consent gate -- the venue receives, so it must stand alone: inline CSS, no
external assets, no scripts, every number server-rendered.

Expected ``result`` shape (produced by ``scalability_agent.engine.pipeline``;
every key is optional here so a partially-evolving v1 result never crashes
the render -- missing pieces simply omit their section)::

    {
        "current_venue": "IBKR",
        "catalog_version": 1,
        "aum_usd": 5_000_000,
        "strategy": {"edge_bps": 35.0, ...},   # StrategyProfile asdict
        "comparison": {
            "current_venue": "IBKR",
            "current": {
                "venue": "IBKR",
                "ceiling_usd": 12_000_000,
                "binding_constraint": "impact",
                "decomposition": {"fees_bps": 8.0, "spread_bps": 5.0,
                                  "impact_bps": 22.0, "edge_bps": 35.0},
                "confidence_band_usd": {"low": 8_000_000, "high": 18_000_000},
            },
            "alternatives": [
                {"venue": "UBS", "display_name": "UBS Execution Services",
                 "eligible": True, "near_miss": False,
                 "ceiling_usd": 30_000_000, "booking_link": "https://...",
                 "reasons": ["deeper liquidity", "lower fees"]},
            ],
            "best_alternative": {...} | None,
        },
        "disclaimer": "v1 heuristic ...",
    }
"""
from __future__ import annotations

import html
from typing import Any

_CSS = """
body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
       color: #1a2332; background: #f6f7f9; margin: 0; padding: 32px 16px; }
.report { max-width: 860px; margin: 0 auto; background: #fff; border: 1px solid #e2e6ec;
          border-radius: 10px; padding: 36px 40px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 16px; text-transform: uppercase; letter-spacing: .04em; color: #5a6675;
     border-bottom: 1px solid #e2e6ec; padding-bottom: 6px; margin: 32px 0 12px; }
.meta { color: #5a6675; font-size: 13px; margin-bottom: 8px; }
.headline { font-size: 34px; font-weight: 700; margin: 8px 0 2px; }
.headline-sub { color: #5a6675; font-size: 14px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef1f4; }
th { color: #5a6675; font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px;
         font-weight: 600; }
.badge.ok { background: #e3f5e9; color: #177245; }
.badge.no { background: #f3f4f6; color: #6b7280; }
.badge.near { background: #fdf1dc; color: #96650f; }
ul.reasons { margin: 4px 0 0; padding-left: 18px; }
ul.reasons li { margin: 2px 0; }
a.book { color: #0b5fff; font-weight: 600; text-decoration: none; }
.disclaimer { margin-top: 36px; padding: 14px 16px; background: #f6f7f9;
              border: 1px solid #e2e6ec; border-radius: 8px; color: #5a6675;
              font-size: 12.5px; line-height: 1.5; }
"""

_METHODOLOGY_FALLBACK = (
    "This report uses the v1 heuristic scalability model: trading costs are "
    "estimated as venue fees plus half-spread plus a square-root market-impact "
    "term (scaled by each venue's liquidity multiplier), and the ceiling is "
    "the fund size at which total daily cost reaches the strategy's estimated "
    "edge. Figures are estimates with a coarse confidence band, pending "
    "Phase-0 validation against realized execution data. Not investment advice."
)


def _esc(value: Any) -> str:
    return html.escape(str(value))


def _usd(value: Any) -> str:
    """Format a dollar figure compactly ($12.0M), or an em dash when absent."""
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return "—"
    if amount >= 1_000_000_000:
        return f"${amount / 1_000_000_000:.1f}B"
    if amount >= 1_000_000:
        return f"${amount / 1_000_000:.1f}M"
    if amount >= 1_000:
        return f"${amount / 1_000:.0f}K"
    return f"${amount:,.0f}"


def _bps(value: Any) -> str:
    try:
        return f"{float(value):.1f} bps"
    except (TypeError, ValueError):
        return "—"


def _pct(value: Any) -> str:
    try:
        return f"{float(value):+.0f}%"
    except (TypeError, ValueError):
        return "—"


def _render_decomposition(decomp: dict) -> str:
    rows = []
    labels = [
        ("fees_bps", "Venue fees"),
        ("spread_bps", "Spread cost"),
        ("impact_bps", "Market impact"),
        ("edge_bps", "Estimated strategy edge"),
    ]
    for key, label in labels:
        if key in decomp:
            rows.append(f"<tr><td>{_esc(label)}</td><td class='num'>{_bps(decomp.get(key))}</td></tr>")
    if not rows:
        return ""
    return (
        "<h2>What caps you</h2><table>"
        "<tr><th>Cost component</th><th class='num'>Daily cost</th></tr>"
        + "".join(rows)
        + "</table>"
    )


def _render_candidates(candidates: list, current_ceiling: Any = None) -> str:
    if not candidates:
        return ""
    rows = []
    for cand in candidates:
        if cand.get("eligible"):
            badge = "<span class='badge ok'>Eligible</span>"
        elif cand.get("near_miss"):
            badge = "<span class='badge near'>Almost eligible</span>"
        else:
            badge = "<span class='badge no'>Not eligible</span>"
        name = _esc(cand.get("display_name") or cand.get("venue") or "?")
        reasons = cand.get("reasons") or []
        reasons_html = (
            "<ul class='reasons'>" + "".join(f"<li>{_esc(r)}</li>" for r in reasons) + "</ul>"
            if reasons
            else ""
        )
        link = cand.get("booking_link")
        link_html = f"<a class='book' href='{_esc(link)}'>Book a consultation</a>" if link and cand.get("eligible") else ""
        ceiling_usd = cand.get("ceiling_usd")
        uplift = None
        try:
            if ceiling_usd is not None and current_ceiling and float(current_ceiling) > 0:
                uplift = (float(ceiling_usd) / float(current_ceiling) - 1.0) * 100.0
        except (TypeError, ValueError):
            uplift = None
        rows.append(
            "<tr>"
            f"<td><strong>{name}</strong><br>{badge}</td>"
            f"<td class='num'>{_usd(ceiling_usd)}</td>"
            f"<td class='num'>{_pct(uplift)}</td>"
            f"<td>{reasons_html}{link_html}</td>"
            "</tr>"
        )
    return (
        "<h2>What a better-matched venue could unlock</h2><table>"
        "<tr><th>Venue</th><th class='num'>Estimated ceiling</th>"
        "<th class='num'>vs. current</th><th>Why</th></tr>"
        + "".join(rows)
        + "</table>"
    )


def render_html(result: dict) -> str:
    """Render the engine's result dict as a self-contained HTML report."""
    comparison = result.get("comparison") or {}
    ceiling = comparison.get("current") or {}
    strategy = result.get("strategy") or {}
    confidence = ceiling.get("confidence_band_usd") or {}

    current_venue = result.get("current_venue") or ceiling.get("venue") or "current venue"
    ceiling_aum = ceiling.get("ceiling_usd")
    binding = ceiling.get("binding_constraint")

    headline = (
        f"<div class='headline'>{_usd(ceiling_aum)}</div>"
        f"<div class='headline-sub'>estimated scalability ceiling on {_esc(current_venue)}"
        + (f" — capped by {_esc(binding)}" if binding else "")
        + "</div>"
        if ceiling_aum is not None
        else ""
    )

    band = ""
    if confidence.get("low") is not None or confidence.get("high") is not None:
        band = (
            "<h2>Confidence band</h2>"
            f"<p>Between <strong>{_usd(confidence.get('low'))}</strong> and "
            f"<strong>{_usd(confidence.get('high'))}</strong>. The band is coarse by "
            "design: v1 is a heuristic, not a measured execution model.</p>"
        )

    facts = []
    aum = result.get("aum_usd") if result.get("aum_usd") is not None else strategy.get("aum_usd")
    if aum is not None:
        facts.append(f"current AUM <strong>{_usd(aum)}</strong>")
    if strategy.get("edge_bps") is not None:
        facts.append(f"estimated edge <strong>{_bps(strategy.get('edge_bps'))}</strong>/day")
    facts_html = f"<p class='meta'>Based on {'; '.join(facts)}.</p>" if facts else ""

    meta_bits = [
        bit
        for bit in (
            f"venue catalog v{_esc(result.get('catalog_version'))}" if result.get("catalog_version") is not None else None,
        )
        if bit
    ]
    meta_html = f"<p class='meta'>{' · '.join(meta_bits)}</p>" if meta_bits else ""

    methodology = result.get("methodology") or _METHODOLOGY_FALLBACK

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Venue Scalability Report — {_esc(current_venue)}</title>
<style>{_CSS}</style>
</head>
<body>
<div class="report">
<h1>Venue Scalability Report</h1>
{meta_html}
{facts_html}
{headline}
{_render_decomposition(ceiling.get("decomposition") or {})}
{band}
{_render_candidates(comparison.get("alternatives") or [], ceiling_aum)}
<div class="disclaimer"><strong>Methodology (v1).</strong> {_esc(methodology)}</div>
</div>
</body>
</html>
"""
