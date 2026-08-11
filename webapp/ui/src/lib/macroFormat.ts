import type { MacroChangeUnit, MacroUnit } from '@/lib/api'

/**
 * Formatting and colour rules for the Macro Desk.
 *
 * The colour rules are the load-bearing part. The palette has exactly one
 * accent, so meaning has to be carried by hue *and* by fill:
 *
 *   primary   a gain, a positive relationship
 *   clay      a loss, a drawdown, a negative relationship
 *   hollow    not distinguishable from zero — same hue, reduced fill
 *   foreground/opacity   a value-neutral magnitude (a days share, a hit rate)
 *   destructive          a failed request, and nothing else
 *
 * `clay` is never a *series identity*. It means "negative verdict" everywhere
 * else in the app, and a line labelled "DXY" drawn in clay beside a bar meaning
 * "you lost money" would destroy that. Series are distinguished by opacity and
 * dash instead — see SERIES_STROKES.
 */

/** Two-sided normal critical values; 1.96 is the 5% line. */
export const T_STRONG = 2.58
export const T_SIG = 1.96
export const T_WEAK = 1.65

export type Significance = '***' | '**' | '*' | 'ns' | '—'

export function significance(t: number | null | undefined): Significance {
  if (t == null || !Number.isFinite(t)) return '—'
  const a = Math.abs(t)
  if (a >= T_STRONG) return '***'
  if (a >= T_SIG) return '**'
  if (a >= T_WEAK) return '*'
  return 'ns'
}

export function isSignificant(t: number | null | undefined): boolean {
  return t != null && Number.isFinite(t) && Math.abs(t) >= T_SIG
}

/**
 * Six line styles that vary opacity and dash but never hue.
 *
 * See the module note: a second accent colour is not available, and reusing
 * `clay` for a series would collide with its meaning everywhere else.
 */
export const SERIES_STROKES = [
  { stroke: 'hsl(var(--primary))', strokeDasharray: undefined },
  { stroke: 'hsl(var(--foreground) / 0.80)', strokeDasharray: undefined },
  { stroke: 'hsl(var(--muted-foreground))', strokeDasharray: undefined },
  { stroke: 'hsl(var(--primary) / 0.65)', strokeDasharray: '5 3' },
  { stroke: 'hsl(var(--foreground) / 0.55)', strokeDasharray: '5 3' },
  { stroke: 'hsl(var(--muted-foreground) / 0.8)', strokeDasharray: '2 3' },
] as const

export const MAX_SERIES = SERIES_STROKES.length

/**
 * A background tint for a z-score.
 *
 * Returns undefined below |z| = 0.28 so a series sitting at its own average is
 * left untinted rather than washed a faint colour that reads as a signal. Null
 * (too little history to score) is likewise untinted — never a fabricated zero.
 *
 * This is *direction against precedent*, not desirability: a high VIX is not
 * "bad" here, and the UI says so next to the strip.
 */
export function zTint(z: number | null | undefined): string | undefined {
  if (z == null || !Number.isFinite(z) || Math.abs(z) < 0.28) return undefined
  const token = z > 0 ? '--primary' : '--clay'
  const alpha = Math.min(0.22, 0.05 + (Math.abs(z) / 3) * 0.17)
  return `hsl(var(${token}) / ${alpha.toFixed(3)})`
}

export type ZMark = { level: 'high' | 'extreme'; sign: 1 | -1 } | null

/**
 * A discrete flag for a level far from its own history.
 *
 * Two levels, not a gradient. The snapshot strip tinted all 31 tiles on a
 * continuous z-scale and the result said nothing — if everything is marked,
 * nothing is. Null below 1.5 sigma, and null for an unscored series rather
 * than a fabricated zero.
 */
export function zMark(z: number | null | undefined): ZMark {
  if (z == null || !Number.isFinite(z)) return null
  const magnitude = Math.abs(z)
  if (magnitude < 1.5) return null
  return { level: magnitude >= 2.5 ? 'extreme' : 'high', sign: z > 0 ? 1 : -1 }
}

/** Sign colour for a number. `negative` forces clay (drawdowns). */
export function toneFor(
  value: number | null | undefined,
  negative = false,
): string {
  if (value == null || !Number.isFinite(value) || value === 0) return ''
  if (negative) return 'text-clay'
  return value > 0 ? 'text-primary' : 'text-clay'
}

/** A level, formatted for its unit. */
export function formatLevel(
  value: number | null | undefined,
  unit: MacroUnit,
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (unit === 'percent') return `${value.toFixed(2)}%`
  if (unit === 'log_ratio') return value.toFixed(4)
  return Math.abs(value) >= 1000
    ? value.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : value.toFixed(2)
}

/**
 * A change, formatted for the transform that produced it.
 *
 * Basis points only for a differenced yield. A differenced log ratio is a
 * relative-performance move on the same scale as a log return, and labelling
 * it "bp" would put the axis out by four orders of magnitude.
 */
export function formatChange(
  value: number | null | undefined,
  changeUnit: MacroChangeUnit,
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  if (changeUnit === 'bps') return `${sign}${value.toFixed(1)}bp`
  return `${sign}${(value * 100).toFixed(2)}%`
}

export function formatPercent(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(digits)}%`
}

export function formatSigned(
  value: number | null | undefined,
  digits = 2,
): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}`
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * Render an ISO date without ever constructing a Date.
 *
 * `new Date('2026-08-07')` is parsed as UTC midnight and then rendered in the
 * viewer's zone, so west of Greenwich it prints the 6th. On an economic-release
 * calendar that is a wrong answer, not a cosmetic one — so this splits the
 * string and never parses it.
 */
export function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  const month = MONTHS[Number(m) - 1]
  if (!month || !d || !y) return iso
  return `${d} ${month} ${y}`
}

/** "07 Aug" — for dense calendar rows where the year is already implied. */
export function formatIsoDayMonth(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [, m, d] = iso.slice(0, 10).split('-')
  const month = MONTHS[Number(m) - 1]
  return month && d ? `${d} ${month}` : String(iso)
}

/** Today in ISO, in the viewer's own zone — not UTC. */
export function todayIso(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Whole days between two ISO dates, positive when `b` is later. */
export function daysBetween(a: string, b: string): number {
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000)
}
