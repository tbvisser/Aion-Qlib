/**
 * When an information coefficient is worth acting on.
 *
 * These thresholds were written down three times — the Databank's `Metric`, the
 * Indicators detail panel, and (nearly) a fourth copy in the canvas — with the
 * Indicators one using a different number. Three surfaces quietly disagreeing
 * about what counts as signal is worse than any single choice of threshold.
 *
 * Separate from `IcResult.tsx` so vitest can reach it: the runner includes
 * `src/**\/*.test.ts` only, and a test importing JSX would not be collected.
 */
import type { FactorEvaluation, IcStats } from '@/lib/api'

/** |IC| at or above this is a usable equity signal. */
export const IC_STRONG = 0.02
/** |ICIR| at or above this means the IC is stable enough to trade. */
export const ICIR_STRONG = 0.3

export const HORIZONS = [1, 5, 10, 20] as const

export type IcField = 'mean' | 'ir'

/**
 * Does this number clear the bar?
 *
 * **Magnitude, not sign.** An IC of −0.05 is a good factor pointing the wrong
 * way — flip it and you have a signal. Colouring it as a failure, which a
 * sign-based rule does, throws away the most useful result a search can return.
 */
export function isStrong(value: number | null | undefined, field: IcField): boolean {
  if (value == null || !Number.isFinite(value)) return false
  return Math.abs(value) >= (field === 'ir' ? ICIR_STRONG : IC_STRONG)
}

export function icTone(
  value: number | null | undefined, field: IcField,
): 'strong' | 'weak' | 'unknown' {
  if (value == null || !Number.isFinite(value)) return 'unknown'
  return isStrong(value, field) ? 'strong' : 'weak'
}

/**
 * One sentence about what a result means, or null when it speaks for itself.
 *
 * Returned rather than rendered so all three surfaces say the same thing.
 */
export function icVerdict(result: FactorEvaluation): string | null {
  const ic = result.ic?.mean
  const ir = result.ic?.ir

  if (ic == null || !Number.isFinite(ic)) {
    return 'No usable observations — the expression produced nothing to correlate. '
      + 'A column that needs more history than the window holds does this.'
  }
  if (!isStrong(ic, 'mean')) {
    return `A mean IC of ${ic.toFixed(4)} is inside the noise for this horizon. `
      + 'Ranking on it is close to ranking at random.'
  }
  if (!isStrong(ir, 'ir')) {
    return `The IC averages ${ic.toFixed(4)}, but it is unstable — an ICIR of `
      + `${ir == null ? '—' : ir.toFixed(2)} means the sign moves around. It may not `
      + 'survive a different period.'
  }
  if (ic < 0) {
    return `A mean IC of ${ic.toFixed(4)} is real signal pointing the wrong way. `
      + 'Negating the expression would rank the same names the other way up.'
  }
  return null
}

/** The four figures every IC surface shows, in one order. */
export function icRows(result: FactorEvaluation): {
  key: string; label: string; value: number | null; field: IcField
}[] {
  const pick = (stats: IcStats | undefined, field: IcField) =>
    (stats?.[field] ?? null) as number | null
  return [
    { key: 'ic', label: 'IC', value: pick(result.ic, 'mean'), field: 'mean' },
    { key: 'icir', label: 'ICIR', value: pick(result.ic, 'ir'), field: 'ir' },
    { key: 'rank_ic', label: 'Rank IC', value: pick(result.rank_ic, 'mean'), field: 'mean' },
    { key: 'rank_icir', label: 'Rank ICIR', value: pick(result.rank_ic, 'ir'), field: 'ir' },
  ]
}
