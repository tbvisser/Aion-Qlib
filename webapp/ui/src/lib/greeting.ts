/**
 * Home/dashboard greeting helpers.
 * Pure functions — no deps — so they're trivially testable.
 */

/** Local-time bands (24h): night wraps midnight (22:00–04:59). */
type Band = 'early' | 'morning' | 'afternoon' | 'evening' | 'night'

function bandFor(hour: number): Band {
  if (hour >= 5 && hour < 8) return 'early'
  if (hour >= 8 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 22) return 'evening'
  return 'night' // 22:00–23:59 and 00:00–04:59
}

/** Weekday-default greeting per band (Tue–Thu + weekends). */
const BASE: Record<Band, string> = {
  early: 'Early start',
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
  night: 'Working late',
}

/** Day-specific overrides (0=Sun … 6=Sat); only bands that differ from BASE. */
const ACCENTS: Record<number, Partial<Record<Band, string>>> = {
  1: { early: 'New week, off early', morning: 'New week' }, // Monday
  5: { afternoon: 'Almost the weekend', evening: "Weekend's here", night: 'Wrapping up the week' }, // Friday
}

/**
 * Time-aware greeting headline resolved from the user's local clock.
 * Resolution order: day-accent override → base band greeting → "Welcome back".
 * Takes an injectable Date so it stays trivially testable.
 */
export function getGreetingHeadline(now: Date = new Date()): string {
  const band = bandFor(now.getHours())
  const weekday = now.getDay()
  return ACCENTS[weekday]?.[band] ?? BASE[band] ?? 'Welcome back'
}

/**
 * First name derived from an email's local part.
 * e.g. "thomas.visser@x.com" -> "Thomas". Falls back to "there".
 * Mirrors the title-case logic used in components/UserMenu.tsx.
 */
export function getFirstName(email?: string | null): string {
  if (!email) return 'there'
  const first = email.split('@')[0].split(/[._-]/)[0]
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'there'
}
