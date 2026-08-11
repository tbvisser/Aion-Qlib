/**
 * The train / validate / test windows as geometry, against what the store holds.
 *
 * Six independent date inputs and a prose note about their ordering is not a
 * picture of anything. You cannot see that validation overlaps training, that
 * the test window is two months long, or — the expensive one — that the end
 * date runs past what the store can answer for, so the run will stop earlier
 * than the form says.
 *
 * **This module emits geometry and short marker labels. It never emits
 * sentences.** The server already writes the overlap and clamp prose
 * (`strategies.validate_windows`), and those exact strings are what the Run
 * button's tooltip and the blocker dedup consume. A second, client-side voice
 * saying the same thing differently would appear twice and match neither.
 */
import type { StrategySpec } from '@/lib/api'

export type BandKey = 'train' | 'valid' | 'test'

export interface Band {
  key: BandKey
  label: string
  start: string
  end: string
  leftPct: number
  widthPct: number
  /** Days, on the plain calendar — not trading days, which we cannot count here. */
  days: number
}

export interface Marker {
  key: string
  pct: number
  label: string
  tone: 'clay' | 'muted'
}

export interface Timeline {
  /** The axis, which always covers both the spec and the store. */
  start: string
  end: string
  bands: Band[]
  markers: Marker[]
  /** The store's own range, drawn as a track under the bands. */
  coverage: { leftPct: number; widthPct: number } | null
  /**
   * The part of the test band the run will not reach, because the end date is
   * past the store's last safely backtestable day.
   */
  clamped: { leftPct: number; widthPct: number } | null
  /** True when any two bands overlap. Geometry only — the server says why. */
  overlapping: boolean
}

const DAY = 86_400_000

/**
 * `YYYY-MM-DD` -> epoch ms, or NaN.
 *
 * Parsed rather than compared as strings because the axis needs *distance*, not
 * order: two windows can be correctly ordered and wildly different lengths, and
 * a lexical compare cannot draw that.
 */
const at = (iso: string | null | undefined): number =>
  iso ? Date.parse(`${iso}T00:00:00Z`) : NaN

const daysBetween = (a: number, b: number) => Math.max(0, Math.round((b - a) / DAY))

const BAND_LABEL: Record<BandKey, string> = {
  train: 'Train', valid: 'Validate', test: 'Backtest',
}

export function timeline(
  spec: Pick<StrategySpec,
    'train_start' | 'train_end' | 'valid_start' | 'valid_end' | 'test_start' | 'test_end'>,
  bounds: {
    calendarStart?: string | null
    calendarEnd?: string | null
    effectiveTestEnd?: string | null
  } = {},
): Timeline | null {
  const raw: { key: BandKey; start: string; end: string }[] = [
    { key: 'train', start: spec.train_start, end: spec.train_end },
    { key: 'valid', start: spec.valid_start, end: spec.valid_end },
    { key: 'test', start: spec.test_start, end: spec.test_end },
  ]

  const stamps = raw.flatMap((b) => [at(b.start), at(b.end)])
  if (stamps.some((s) => Number.isNaN(s))) return null

  const coverStart = at(bounds.calendarStart)
  const coverEnd = at(bounds.calendarEnd)

  // The axis spans the spec *and* the store, so a training window that starts
  // before the data does is visible as exactly that rather than clipped away.
  const min = Math.min(...stamps, ...(Number.isNaN(coverStart) ? [] : [coverStart]))
  const max = Math.max(...stamps, ...(Number.isNaN(coverEnd) ? [] : [coverEnd]))
  const span = max - min

  // A zero-width axis would make every percentage Infinity. One day is the
  // smallest honest span, and it renders as a single hairline.
  const pct = (t: number) => (span > 0 ? ((t - min) / span) * 100 : 0)
  const clamp01 = (v: number) => Math.min(100, Math.max(0, v))

  const bands: Band[] = raw.map((b) => {
    const from = at(b.start)
    const to = at(b.end)
    const left = clamp01(pct(from))
    // Inverted windows (`end` before `start`) collapse to zero width rather
    // than drawing backwards. The server refuses them in words.
    const width = clamp01(pct(Math.max(to, from))) - left
    return {
      key: b.key,
      label: BAND_LABEL[b.key],
      start: b.start,
      end: b.end,
      leftPct: left,
      widthPct: width,
      days: daysBetween(from, Math.max(to, from)),
    }
  })

  const markers: Marker[] = []
  if (!Number.isNaN(coverEnd)) {
    markers.push({
      key: 'calendar-end',
      pct: clamp01(pct(coverEnd)),
      label: 'last safe day',
      tone: 'clay',
    })
  }

  const effective = at(bounds.effectiveTestEnd)
  const testEnd = at(spec.test_end)
  const clamped =
    !Number.isNaN(effective) && effective < testEnd
      ? {
        leftPct: clamp01(pct(effective)),
        widthPct: clamp01(pct(testEnd)) - clamp01(pct(effective)),
      }
      : null

  const overlapping =
    at(spec.valid_start) <= at(spec.train_end) || at(spec.test_start) <= at(spec.valid_end)

  return {
    start: new Date(min).toISOString().slice(0, 10),
    end: new Date(max).toISOString().slice(0, 10),
    bands,
    markers,
    coverage:
      !Number.isNaN(coverStart) && !Number.isNaN(coverEnd)
        ? {
          leftPct: clamp01(pct(coverStart)),
          widthPct: clamp01(pct(coverEnd)) - clamp01(pct(coverStart)),
        }
        : null,
    clamped,
    overlapping,
  }
}
