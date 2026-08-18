"""Named assumptions of the v1 ceiling heuristic.

Every magic number the engine relies on lives here, as a named constant, so
Phase-0 validation can tune the model in one place and every report can state
exactly which assumptions produced it. These are heuristics pending Phase-0
validation against backtests / case studies (PRD §9 gate G0) — treat them as
calibration knobs, not ground truth.
"""

# --- Market impact (square-root law) ---------------------------------------
# impact_bps = IMPACT_Y * sigma_bps * sqrt(Q / ADV), the standard empirical
# square-root market-impact model for institutional order flow.
IMPACT_Y = 0.7

# Daily volatility fallback in bps when it cannot be estimated from data
# (trade-level uploads carry no prices-through-time, so v1 always falls back).
DEFAULT_SIGMA_BPS = 200.0

# Maximum share of a symbol's daily volume the strategy may be before we call
# the venue "full" — a hard liquidity cap independent of the cost math.
P_MAX = 0.10

# The upload only shows what the fund itself traded. To approximate venue ADV
# we assume the fund historically traded at this participation rate, so
# ADV ≈ own daily notional / HISTORICAL_PARTICIPATION.
HISTORICAL_PARTICIPATION = 0.05

# --- Edge estimation --------------------------------------------------------
# When the upload carries no usable fee data, assume the strategy earns this
# gross edge per unit of turnover (bps on traded notional, per side).
DEFAULT_EDGE_BPS = 50.0

# When commissions are present, estimate edge as a multiple of observed fee
# costs — a strategy that survives at fee level X presumably earns more than
# X, but without P&L data a conservative multiple is all we can justify.
EDGE_FEE_MULTIPLE = 3.0

# --- Turnover scaling -------------------------------------------------------
# Scaling the strategy to AUM A assumes daily traded notional = f * A. When
# the fund's current AUM is unknown (job params carry no aum_usd) we cannot
# derive f from the upload and fall back to this fraction.
DEFAULT_DAILY_TURNOVER_FRACTION = 0.20

# A market order pays roughly half the quoted spread per side.
SPREAD_COST_FRACTION = 0.5

# --- Ceiling search ---------------------------------------------------------
BISECTION_ITERS = 60
CEILING_SEARCH_MIN_AUM = 1.0  # USD
CEILING_SEARCH_MAX_AUM = 1e11  # USD; above this the model is not credible

# --- Confidence band (coarse, per PRD: intervals, not point numbers) --------
CEILING_CONFIDENCE_LOW_MULT = 0.5
CEILING_CONFIDENCE_HIGH_MULT = 2.0

# --- Eligibility ------------------------------------------------------------
# A fund within this factor of a venue's min_aum is flagged as a near miss —
# per the PRD's UBS example, "you almost qualify" is a feature, not an error.
NEAR_MISS_AUM_FACTOR = 0.8
