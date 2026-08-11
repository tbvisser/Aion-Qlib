import type { QuadrantState } from '@/lib/api'

/**
 * Colour for regime *states*, and nowhere else.
 *
 * The app has one accent (mint `--primary`) plus `--clay`, and `macroFormat.ts`
 * is emphatic that clay means "a negative statistical verdict" and must never
 * be a category identity. But a growth/inflation quadrant has four genuinely
 * distinct states, and four categories cannot be told apart by opacity.
 *
 * So this file imports the Aion Platform's regime palette — the same
 * amber/emerald/rose/sky it uses in `regimeMeta.ts` — and confines it strictly
 * to quadrant states. Rate cycle gets a neutral chip plus a glyph; risk and
 * market keep mint/clay, which is what risk-on and risk-off actually are.
 *
 * Reusing rose for both "Stagflation" and "hiking" (as Aion's `STANCE_TONES`
 * does) double-books the hue and recreates the tint-patchwork problem in a new
 * colour space. `regimeTone.test.ts` asserts the separation.
 *
 * **Every class string is a literal.** Tailwind's JIT scanner cannot see
 * `bg-${hue}-500/15`, and an interpolated class silently renders unstyled.
 */
export interface RegimeTone {
  /** The pill on the verdict panel. */
  chip: string
  /** A saturated 8px legend dot. */
  dot: string
  /** A 24px ribbon cell — lighter, so a strip of 24 does not shout. */
  cell: string
  text: string
  /** The left accent on the verdict band. */
  band: string
}

export const QUADRANT_TONES: Record<QuadrantState, RegimeTone> = {
  reflation: {
    chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-500 border border-amber-500/25',
    dot: 'bg-amber-500',
    cell: 'bg-amber-500/70',
    text: 'text-amber-600 dark:text-amber-500',
    band: 'border-l-amber-500',
  },
  goldilocks: {
    chip: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-500 border border-emerald-500/25',
    dot: 'bg-emerald-500',
    cell: 'bg-emerald-500/70',
    text: 'text-emerald-600 dark:text-emerald-500',
    band: 'border-l-emerald-500',
  },
  stagflation: {
    chip: 'bg-rose-500/15 text-rose-600 dark:text-rose-500 border border-rose-500/25',
    dot: 'bg-rose-500',
    cell: 'bg-rose-500/70',
    text: 'text-rose-600 dark:text-rose-500',
    band: 'border-l-rose-500',
  },
  disinflationary_slowdown: {
    chip: 'bg-sky-500/15 text-sky-600 dark:text-sky-500 border border-sky-500/25',
    dot: 'bg-sky-500',
    cell: 'bg-sky-500/70',
    text: 'text-sky-600 dark:text-sky-500',
    band: 'border-l-sky-500',
  },
  // A resolved state, not a failure — so it is distinguishable from unknown.
  transitional: {
    chip: 'bg-slate-500/15 text-muted-foreground border border-slate-500/25',
    dot: 'bg-slate-500',
    cell: 'bg-slate-500/60',
    text: 'text-muted-foreground',
    band: 'border-l-slate-500',
  },
  unknown: {
    chip: 'bg-slate-500/10 text-muted-foreground border border-slate-500/20',
    dot: 'bg-slate-500/60',
    cell: 'bg-slate-500/25',
    text: 'text-muted-foreground',
    band: 'border-l-muted-foreground',
  },
}

/** Legend and playbook row order. Fixed, so switching lens does not reshuffle. */
export const QUADRANT_ORDER: readonly QuadrantState[] = [
  'reflation', 'goldilocks', 'stagflation', 'disinflationary_slowdown', 'transitional',
]

export const QUADRANT_LABELS: Record<QuadrantState, string> = {
  reflation: 'Reflation',
  goldilocks: 'Goldilocks',
  stagflation: 'Stagflation',
  disinflationary_slowdown: 'Disinflationary slowdown',
  transitional: 'Transitional',
  unknown: 'Unresolved',
}

/**
 * Keyed on the machine ``state``, never on the display label — a reworded
 * label must not silently drop every cell to slate.
 */
export function quadrantTone(state: string | null | undefined): RegimeTone {
  const key = (state ?? '').toLowerCase() as QuadrantState
  return QUADRANT_TONES[key] ?? QUADRANT_TONES.unknown
}

export function quadrantLabel(state: string | null | undefined): string {
  const key = (state ?? '').toLowerCase() as QuadrantState
  return QUADRANT_LABELS[key] ?? QUADRANT_LABELS.unknown
}

/** Rate-cycle stage as a single glyph, for the ribbon's second channel. */
export function rateStageGlyph(stage: string | null | undefined): '↑' | '↓' | '–' | '·' {
  if (!stage) return '·'
  if (stage.startsWith('Hiking')) return '↑'
  if (stage.startsWith('Cutting')) return '↓'
  return '–'
}

const MINT: RegimeTone = {
  chip: 'bg-primary/15 text-primary border border-primary/25',
  dot: 'bg-primary', cell: 'bg-primary/60', text: 'text-primary',
  band: 'border-l-primary',
}
const CLAY: RegimeTone = {
  chip: 'bg-clay/15 text-clay border border-clay/25',
  dot: 'bg-clay', cell: 'bg-clay/60', text: 'text-clay',
  band: 'border-l-clay',
}
const NEUTRAL: RegimeTone = {
  chip: 'bg-foreground/[0.07] text-muted-foreground',
  dot: 'bg-muted-foreground/50', cell: 'bg-foreground/15',
  text: 'text-muted-foreground', band: 'border-l-muted-foreground',
}

/** Risk-on / risk-off is a verdict, so it uses the verdict palette. */
export function riskTone(label: string | null | undefined): RegimeTone {
  if (label === 'Risk-On') return MINT
  if (label === 'Risk-Off') return CLAY
  return NEUTRAL
}

/** The price-based lens: rates direction is the hue, vol is the glyph. */
export function marketTone(state: string | null | undefined): RegimeTone {
  if (!state) return NEUTRAL
  if (state.startsWith('rising')) return MINT
  if (state.startsWith('falling')) return CLAY
  return NEUTRAL
}

export function marketGlyph(state: string | null | undefined): '▲' | '▼' | '·' {
  if (!state) return '·'
  if (state.endsWith('_high')) return '▲'
  if (state.endsWith('_low')) return '▼'
  return '·'
}

export const NEUTRAL_TONE = NEUTRAL
