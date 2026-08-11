/**
 * Trading costs as basis points, without changing what goes over the wire.
 *
 * `StrategySpec` carries fractions — 0.0005, 0.0015 — because that is what
 * qlib's `exchange_kwargs` takes, and the server range-checks them as fractions
 * (`ge=0, le=0.05`). Nobody in a trading seat says "five ten-thousandths"; they
 * say "5 bps". So the conversion is presentation-only and the spec is untouched.
 *
 * The rounding is the whole reason this is a module rather than two inline
 * multiplications. Most values are exact — `0.0005 * 10000` really is `5` — but
 * not all of them: `0.0003 * 10000` is `2.9999999999999996` and `0.0029 * 10000`
 * is `28.999999999999996`. A cost field that reads `2.9999999999999996 bps`
 * after one focus/blur is worse than the fraction it replaced, and the values
 * that misbehave are not the ones anybody would think to check. So round on the
 * way out, and round on the way back so a trip through the control cannot
 * perturb a saved spec.
 */

/** The server's `le=0.05` in the unit the control speaks. */
export const MAX_BPS = 500

const round = (value: number, places: number) => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/** Fraction of notional -> basis points. `0.0005` -> `5`. */
export function toBps(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0
  // Four places is well past anything a cost model expresses and still short of
  // where binary floating point starts inventing digits.
  return round(fraction * 10_000, 4)
}

/** Basis points -> fraction of notional. `5` -> `0.0005`. */
export function fromBps(bps: number): number {
  if (!Number.isFinite(bps)) return 0
  return round(bps / 10_000, 8)
}

/**
 * What a full in-and-out actually costs.
 *
 * The two legs are configured separately and read separately, so the number
 * that decides whether a strategy survives its own turnover is never on screen.
 */
export function roundTripBps(openCost: number, closeCost: number): number {
  return round(toBps(openCost) + toBps(closeCost), 4)
}
