# Venue Scalability Tool — PRD & Module Plan

Source idea: `venue-scalability-tool.pdf` (for Thomas at AION Partners).
Status: concept only — nothing built. The core open question is whether the
scalability calculation itself holds up; everything else comes after that.

---

## 1. Problem

Most funds don't know their real scalability ceiling. They know their AUM
today, but not:

- what is actually capping them (poor execution, thin liquidity *for their
  specific size*, costs quietly eating their edge), or
- what they are losing by trading on a venue that isn't suited to their
  strategy.

There is currently no good self-serve way to answer that question.

## 2. Product

One feature, one simple flow — from *not knowing there's a problem* to a
direct path to the solution:

1. **Upload** — a fund uploads its trading data.
2. **Problem aware** — the tool calculates the fund's real scalability
   ceiling on its current venue, and surfaces what is causing the cap.
3. **Solution aware** — the tool calculates what the *same strategy* could
   achieve on a better-matched venue, with the "why" made explicit
   (e.g. eligibility thresholds the fund may not know it already meets).
4. **Book** — the fund gets a direct link to book a free consultation with
   that better venue.
5. **Handoff** — only once the fund books, the report is forwarded to that
   venue ahead of the meeting. Nothing moves until the fund books; data only
   goes to the new venue as a result of the fund's own action.

The tool doesn't just spit out a number: it pairs the ceiling with a simple,
specific recommendation built around the fund's exact strategy and current
position — not a generic recommendation.

## 3. Business case

- Every fund that acts becomes redirected trade volume → ongoing rebate /
  affiliate revenue for the introducing party (AION).
- Fits existing AION work: already deep in these strategies, optimizing and
  sometimes building them.

## 4. The calculation (core IP)

Three parts, always specific to the fund's actual strategy:

1. **Instruments, position sizes, volume** — what the strategy actually
   trades.
2. **Venue liquidity, specific to that** — depth relevant to the sizes and
   volume this strategy pushes, not generic instrument liquidity.
3. **Execution costs & trading conditions** — what they pay now vs. what a
   better venue could realistically offer.

Output per venue: a ceiling estimate (AUM at which the strategy's edge is
consumed by market impact + costs) plus a decomposition of *what* caps it.

### Worked example (from the brief)

A $20M fund trading through IBKR: ceiling ≈ $400M given current costs and
liquidity. UBS only accepts funds above $20M AUM — the fund may not know it
already qualifies — and the same strategy there ceilings at ≈ $550M.

### Scope line

- **In scope:** MFT and most non-latency-sensitive strategies; any market
  (not FX/CFD-specific).
- **Out of scope:** HFT, swap arb, anything latency-sensitive — the report
  can't capture what matters there. Exact line TBD by Thomas.

## 5. Access model — open question

Platform-only, invite-only, or wide open are all workable. Decision deferred
to Thomas; the architecture should not hard-code any of the three.

## 6. Goals & success metrics

- **G0 (gate):** the ceiling calculation reproduces known outcomes in
  backtests / case studies within an agreed tolerance. *Nothing else ships
  before this.*
- **G1:** a fund can complete upload → report in < 15 minutes self-serve.
- **G2:** ≥ X% of reports that show a material ceiling delta result in a
  booked consultation.
- **G3:** rebate/affiliate revenue per redirected fund tracked and reported.

## 7. Modules

Proposed as a new additive layer in this repo, following the existing
`webapp/` pattern (FastAPI `api/`, React+Vite `ui/`, nothing in `qlib/`
modified; qlib reused as the analytics engine where useful).

### M1 — Data ingestion & normalization
- Upload of broker/venue exports (IBKR Flex/activity statements first; CSV
  generic fallback).
- Parse into a canonical trade/position model: instrument, side, size, price,
  timestamp, fees/commissions, venue.
- Validation + a "what we understood" preview before any calculation runs.
- PII/funds data handling: encrypted at rest, scoped retention, explicit
  deletion.

### M2 — Strategy profiler
- From the normalized trades, derive the strategy fingerprint: instruments,
  typical/percentile position sizes, daily/participation volume, turnover,
  holding period, order-size distribution.
- Classify strategy type well enough to apply the scope line (reject/flag
  latency-sensitive profiles).

### M3 — Liquidity model (per venue)
- Order-book/depth model parameterized by venue and instrument: available
  depth at the sizes this strategy trades, participation-rate limits,
  historical volume curves.
- Data sources: venue-provided specs, market data feeds, calibrated
  estimates where depth data is unavailable (with confidence flags).

### M4 — Cost & conditions model (per venue)
- Commissions, spreads, fees, financing, ticket minimums, eligibility rules
  (e.g. "UBS: ≥ $20M AUM") as structured venue profiles.
- Versioned venue catalog so reports are reproducible and conditions updates
  are auditable.

### M5 — Ceiling engine (the core)
- Inputs: strategy fingerprint (M2) × liquidity model (M3) × cost model (M4).
- Simulates scaling the strategy's AUM and finds the point where impact +
  costs consume the edge → ceiling per venue.
- Decomposes the cap: how much is liquidity vs. explicit costs vs.
  conditions.
- Produces confidence intervals, not a single point number.

### M6 — Comparison & recommendation
- Ranks candidate venues by ceiling delta vs. current venue.
- Explains the "why" in plain language (eligibility unlocked, deeper book at
  your clip size, lower fee tier, …).
- Guardrail: never recommend a venue the fund doesn't qualify for; surface
  near-miss eligibility explicitly (that's a feature, per the UBS example).

### M7 — Report generation
- Fund-facing report: current ceiling + causes, alternative-venue ceiling +
  reasons, clear next step.
- Venue-facing version: what gets forwarded after booking (subset/summary,
  fund-approved).

### M8 — Booking & consent gate
- Calendar/booking integration per venue.
- Hard consent gate: report is forwarded to a venue only on a completed
  booking event. This is a compliance invariant, enforced in one place and
  tested.

### M9 — Admin & revenue tracking
- Funnel analytics: uploads → reports → bookings → redirected volume.
- Rebate/affiliate attribution per venue agreement.

### M10 — Access control
- Implements whichever access model is chosen (§5) behind a feature flag:
  platform-only / invite-only / open.

## 8. Non-functional requirements

- **Data trust is the product.** Fund trading data is highly sensitive:
  encryption at rest/in transit, no data sharing without the booking-triggered
  consent, clear retention/deletion policy, audit log of every data access.
- **Disclaimers:** ceiling figures are estimates with stated methodology and
  confidence, not investment advice.
- Reports reproducible: given the same inputs and venue-catalog version, the
  same output.

## 9. Delivery phases

- **Phase 0 — Prove the calculation (gate).**
  M5 + minimal M2–M4, driven from notebooks/scripts against qlib data. Hand-
  built case studies (incl. the IBKR→UBS example) must reproduce plausible
  ceilings. No UI, no upload. **Go/no-go for everything else.**
- **Phase 1 — Private MVP (one market, 2–3 venues).**
  M1 (IBKR import), M7 (PDF/web report), M8 (booking link + consent gate),
  M10 (invite-only). Concierge-style: early uploads can be semi-manual.
- **Phase 2 — Self-serve.**
  M6 recommendations breadth, venue catalog expansion, generic CSV import,
  polished UI.
- **Phase 3 — Business loop.**
  M9 revenue attribution, venue partnerships feeding real conditions data
  back into M3/M4, access-model decision revisited.

## 10. Open questions

1. Does the ceiling calculation hold up? (Phase 0 answers this.)
2. Access model: platform-only / invite-only / open?
3. Where does venue liquidity/depth data come from at MVP quality — public
   feeds, venue partnerships, calibrated estimates?
4. Rebate split and venue agreements — commercial, post-Phase-0.
5. Where exactly is the strategy-scope line (which MFT strategies are
   modelable, which are not)?

## 11. Suggested repo placement

The analysis runs in a **separate agent service** (see
`IMPLEMENTATION.md`), with only a thin control plane inside the platform:

```
scalability_agent/       # standalone background service (own Docker service)
  agent/                 # worker loop, db queue client, storage client
  engine/                # M2–M5: profiling, liquidity, cost, ceiling (qlib-based)
  report/                # M7: report rendering
webapp/api/routers/scalability.py   # control plane: upload, enqueue, booking gate
venue-scalability-tool/  # docs: this PRD + implementation design
```

As built: the importable package is `scalability_agent/` (underscore,
top-level) and this milestone ships backend + agent only — the React flow
(upload → report → book) under `webapp/ui/` and venue email-forwarding after
booking are deferred to a later milestone; the consent gate
(`report_shared_at`) is already enforced in the API.

Postgres (`aion.scalability_jobs`) is the queue between platform and agent —
no new infrastructure dependency. `qlib/`, `scripts/`, `examples/` stay
untouched; the engine calls qlib the same way `webapp/` does today.
