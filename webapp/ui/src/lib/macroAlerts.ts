import type { MacroCalendar, MacroRelease, MacroSnapshot, MacroSnapshotRow } from '@/lib/api'
import { countryCentroid } from '@/lib/countryCentroids'
import { daysBetween, todayIso } from '@/lib/macroFormat'

export interface MacroAlertPoint {
  country: string
  lat: number
  lng: number
  score: number
  eventCount: number
  topEvent: string
  /** True when the source calendar was stale and these are recent past events. */
  stale?: boolean
  /** Source of the heat score so the UI can explain what the colour means. */
  source?: 'calendar' | 'market' | 'blended'
}

const IMPORTANCE_WEIGHT: Record<string, number> = {
  headline: 3,
  standard: 1,
  low: 0.5,
}

interface ScoreBucket {
  total: number
  count: number
  topEvent: string
  topWeight: number
}

function scoreEvents(
  events: MacroRelease[],
  horizonDays: number,
  referenceDate: string,
  allowPast = false,
): Map<string, ScoreBucket> {
  const scores = new Map<string, ScoreBucket>()

  for (const event of events) {
    if (!event.country) continue
    const daysTo = daysBetween(referenceDate, event.date)
    if (allowPast) {
      // For stale-cache fallback, look backwards up to horizonDays.
      if (daysTo > 0 || daysTo < -horizonDays) continue
    } else if (daysTo < 0 || daysTo > horizonDays) {
      continue
    }

    const importance = event.importance ?? 'standard'
    const baseWeight = IMPORTANCE_WEIGHT[importance] ?? IMPORTANCE.standard
    const urgency = allowPast
      ? (horizonDays + daysTo) / horizonDays
      : (horizonDays - daysTo) / horizonDays
    const weight = baseWeight * urgency

    const key = event.country.toUpperCase()
    const existing = scores.get(key)
    const eventLabel = event.type ?? event.event_key ?? 'Release'
    if (!existing) {
      scores.set(key, { total: weight, count: 1, topEvent: eventLabel, topWeight: weight })
    } else {
      existing.total += weight
      existing.count += 1
      if (weight > existing.topWeight) {
        existing.topWeight = weight
        existing.topEvent = eventLabel
      }
    }
  }

  return scores
}

function pointsFromScores(scores: Map<string, ScoreBucket>, stale = false): MacroAlertPoint[] {
  if (scores.size === 0) return []

  const maxScore = Math.max(...Array.from(scores.values()).map((s) => s.total))
  if (maxScore <= 0) return []

  const points: MacroAlertPoint[] = []
  for (const [country, data] of scores) {
    const centroid = countryCentroid(country)
    if (!centroid) continue
    points.push({
      country,
      lat: centroid.lat,
      lng: centroid.lng,
      score: Math.min(1, data.total / maxScore),
      eventCount: data.count,
      topEvent: data.topEvent,
      stale,
      source: stale ? 'calendar' : 'calendar',
    })
  }

  return points.sort((a, b) => b.score - a.score)
}

/**
 * Turn the upcoming macro calendar into per-country alert intensity.
 *
 * The score blends event importance with urgency: a headline release tomorrow
 * weighs more than a standard release next week. Points are normalized against
 * the hottest country in the current window so the globe's color scale is
 * always meaningful.
 *
 * When the cache is stale and there are no true upcoming events, this falls
 * back to the most recent high-impact events in the cached window so the globe
 * stays useful while the background EODHD refresh catches up.
 */
export function aggregateAlerts(
  calendar: MacroCalendar | null | undefined,
  horizonDays = 14,
): MacroAlertPoint[] {
  if (!calendar?.available) return []

  const today = todayIso()
  const upcoming = scoreEvents(calendar.upcoming ?? [], horizonDays, today, false)
  if (upcoming.size > 0) {
    return pointsFromScores(upcoming, false)
  }

  // Fallback: show recent past events if the cache is behind real-time.
  const recent = scoreEvents(calendar.past ?? [], horizonDays, today, true)
  return pointsFromScores(recent, true)
}

// ---------------------------------------------------------------------------
// Market-stress heat layer: colour the globe from live macro market data even
// when the economic calendar is quiet. Each tracked series is mapped to the
// country whose market it represents; the heat is driven by how far each series
// is from its own history (z-score) and how sharply it has moved recently.
// ---------------------------------------------------------------------------

/** Registry series -> ISO-2 country the market read belongs to. */
const SERIES_COUNTRY_MAP: Record<string, string> = {
  // US rates, vol, dollar, equity and credit
  US3M: 'US',
  US2Y: 'US',
  US5Y: 'US',
  US10Y: 'US',
  US30Y: 'US',
  SLOPE_2S10S: 'US',
  SLOPE_3M10Y: 'US',
  VIX: 'US',
  VXN: 'US',
  MOVE: 'US',
  GVZ: 'US',
  OVX: 'US',
  DXY: 'US',
  AXY: 'US',
  CXY: 'US',
  GSPC: 'US',
  NDX: 'US',
  DJI: 'US',
  BCOM: 'US',
  BCOMCL: 'US',
  BCOMGC: 'US',
  BCOMHG: 'US',
  BCOMNG: 'US',
  // European equity
  STOXX: 'DE',
  // Japan equity
  N225: 'JP',
  // Hong Kong / China proxy
  HSI: 'CN',
  // Derived US reads
  CREDIT_HY_IG: 'US',
  CREDIT_HY_UST: 'US',
  BREAKEVEN_PROXY: 'US',
  COPPER_GOLD: 'US',
}

/** How much each macro dimension contributes to the country stress score. */
const GROUP_WEIGHT: Record<string, number> = {
  rates: 1.2,
  inflation: 1.0,
  growth: 1.0,
  volatility: 1.5,
  dollar: 1.0,
  commodities: 0.8,
  credit: 1.3,
}

function rowStress(row: MacroSnapshotRow): number {
  if (!row.available || row.level == null) return 0

  // Prefer the z-score: a level far from its own history is the cleanest
  // single-number stress read. Fall back to the magnitude of recent moves when
  // there is not enough history to score.
  const z = row.zscore != null && Number.isFinite(row.zscore) ? Math.abs(row.zscore) : 0
  const move = Math.max(
    Math.abs(row.change_1d ?? 0),
    Math.abs(row.change_1w ?? 0) * 0.5,
    Math.abs(row.change_1m ?? 0) * 0.25,
  )

  // Annual/step indicators have no daily move; let their z-score carry them.
  const group = row.group
  const groupWeight = GROUP_WEIGHT[group] ?? 1.0

  // Scale recent log-return moves into a rough sigma-equivalent so a 3% daily
  // equity move competes with a 2-sigma yield move. VIX and vol indices are
  // indices, so treat their percentage change as the signal.
  const moveSigma = group === 'volatility' ? move * 8 : move * 4

  return groupWeight * Math.max(z, moveSigma)
}

interface MarketBucket {
  total: number
  count: number
  topStress: number
  topLabel: string
}

export function aggregateMarketAlerts(snapshot: MacroSnapshot | null | undefined): MacroAlertPoint[] {
  if (!snapshot?.available || !snapshot.rows?.length) return []

  const buckets = new Map<string, MarketBucket>()

  for (const row of snapshot.rows) {
    const country = SERIES_COUNTRY_MAP[row.key]
    if (!country) continue
    const stress = rowStress(row)
    if (stress <= 0) continue

    const existing = buckets.get(country)
    if (!existing) {
      buckets.set(country, {
        total: stress,
        count: 1,
        topStress: stress,
        topLabel: row.label,
      })
    } else {
      existing.total += stress
      existing.count += 1
      if (stress > existing.topStress) {
        existing.topStress = stress
        existing.topLabel = row.label
      }
    }
  }

  if (buckets.size === 0) return []

  const maxScore = Math.max(...Array.from(buckets.values()).map((b) => b.total))
  if (maxScore <= 0) return []

  const points: MacroAlertPoint[] = []
  for (const [country, data] of buckets) {
    const centroid = countryCentroid(country)
    if (!centroid) continue
    points.push({
      country,
      lat: centroid.lat,
      lng: centroid.lng,
      score: Math.min(1, data.total / maxScore),
      eventCount: data.count,
      topEvent: data.topLabel,
      source: 'market',
    })
  }

  return points.sort((a, b) => b.score - a.score)
}

/**
 * Blend calendar event intensity with live market-stress heat.
 *
 * The market layer provides colour even when the calendar is quiet; the
 * calendar layer keeps release counts and the top-event label accurate. The
 * final score is a weighted blend, and the source flag tells the UI which
 * signal is dominant.
 */
export function blendAlerts(
  calendar: MacroAlertPoint[],
  market: MacroAlertPoint[],
  marketWeight = 0.65,
): MacroAlertPoint[] {
  if (!calendar.length) return market
  if (!market.length) return calendar

  const marketByCountry = new Map(market.map((m) => [m.country, m]))
  const maxCalScore = Math.max(1, ...calendar.map((c) => c.score))

  const out: MacroAlertPoint[] = []
  for (const cal of calendar) {
    const m = marketByCountry.get(cal.country)
    const marketScore = m?.score ?? 0
    const score = (marketWeight * marketScore) + ((1 - marketWeight) * (cal.score / maxCalScore))
    out.push({
      ...cal,
      score: Math.min(1, score),
      eventCount: cal.eventCount,
      topEvent: cal.topEvent,
      source: score > 0.55 && marketScore > (cal.score / maxCalScore) ? 'blended' : 'calendar',
    })
  }

  // Add market-only countries that have no upcoming calendar releases.
  const calCountries = new Set(calendar.map((c) => c.country))
  for (const m of market) {
    if (calCountries.has(m.country)) continue
    out.push({
      ...m,
      score: m.score * marketWeight,
      source: 'market',
    })
  }

  return out.sort((a, b) => b.score - a.score)
}
