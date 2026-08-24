import type { MacroCalendar, MacroRelease } from '@/lib/api'
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
    const baseWeight = IMPORTANCE_WEIGHT[importance] ?? IMPORTANCE_WEIGHT.standard
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
