import type { MacroRegimeResponse } from '@/lib/api'
import { type RegimeTone, quadrantTone } from '@/lib/regimeTone'

/**
 * The page's argument, in one sentence.
 *
 * Extracted from the component because forcing every unknown combination
 * through one function is what stops the JSX growing a ternary per lens — and
 * because it is then testable under the app's node-only vitest setup.
 */
export interface VerdictLine {
  headline: string
  /** The evidence clause, or null when nothing resolved. */
  sub: string | null
  tone: RegimeTone
  /** 0-4. Below 4 the band says how many are unresolved. */
  knownLenses: number
}

const UNRESOLVED = 'Regime unresolved'

export function verdictSentence(regime: MacroRegimeResponse | null): VerdictLine {
  const tone = quadrantTone(regime?.quadrant?.state)
  if (!regime || !regime.available) {
    return { headline: UNRESOLVED, sub: null, tone, knownLenses: 0 }
  }

  const { quadrant: q, rate_cycle: c, risk: r, market: m } = regime
  const known = [q.state, c.state, r.state, m.state]
    .filter((state) => state && state !== 'unknown').length

  const clauses: string[] = []
  if (q.state !== 'unknown') {
    const parts = [
      q.growth.direction !== 'unknown' ? `growth ${q.growth.direction}` : null,
      q.inflation.direction !== 'unknown' ? `inflation ${q.inflation.direction}` : null,
    ].filter(Boolean)
    if (parts.length) clauses.push(parts.join(', '))
  }
  if (c.stage !== 'unknown') clauses.push(`policy ${c.stage.toLowerCase()}`)
  if (r.label !== 'unknown') clauses.push(r.label.toLowerCase().replace('-', ' '))
  if (m.state !== 'unknown' && m.label) clauses.push(m.label.toLowerCase())

  return {
    headline: q.state !== 'unknown' && q.label ? q.label : UNRESOLVED,
    sub: clauses.length ? `${clauses.join('; ')}.` : null,
    tone,
    knownLenses: known,
  }
}
