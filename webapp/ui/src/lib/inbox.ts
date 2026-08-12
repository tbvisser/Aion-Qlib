/**
 * Inbox bookkeeping: what counts as unread, and what counts as a regime flip.
 *
 * Pure functions over the activity feed and the regime read, plus the
 * localStorage schema for "seen" state — kept out of the hook so vitest can
 * exercise the rules without a DOM or a provider.
 *
 * Two kinds of unread exist and they are deliberately different:
 * - finished work (a run or job that reached a terminal status after the
 *   Inbox was last open) is compared against a timestamp;
 * - a regime flip is compared against the last *state* the user saw, because
 *   the regime endpoint carries no "changed at" instant — inventing one from
 *   poll time would fabricate precision the data does not have.
 */
import type { ActivityItem, MacroRegimeResponse, RegimeHistoryMonth, RunStatus } from './api'

const LAST_SEEN_KEY = 'aion.inbox.lastSeen'
const REGIME_SEEN_KEY = 'aion.inbox.regimeSeen'

export type RegimeLens = 'quadrant' | 'rate_cycle' | 'risk' | 'market'

export const REGIME_LENS_LABELS: Record<RegimeLens, string> = {
  quadrant: 'Growth / inflation',
  rate_cycle: 'Rate cycle',
  risk: 'Risk appetite',
  market: 'Market regime',
}

export type RegimeSeenMap = Record<RegimeLens, string | null>

const EMPTY_SEEN: RegimeSeenMap = {
  quadrant: null, rate_cycle: null, risk: null, market: null,
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(['succeeded', 'failed', 'cancelled'])

// -- localStorage ----------------------------------------------------------
// Storage can throw (private mode, disabled); the Inbox must degrade to
// "everything unread" rather than crash the shell.

export function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY)
  } catch {
    return null
  }
}

export function writeLastSeen(iso: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, iso)
  } catch {
    /* degrade silently */
  }
}

export function readRegimeSeen(): RegimeSeenMap {
  try {
    const raw = localStorage.getItem(REGIME_SEEN_KEY)
    if (!raw) return { ...EMPTY_SEEN }
    const parsed = JSON.parse(raw) as Partial<RegimeSeenMap>
    return { ...EMPTY_SEEN, ...parsed }
  } catch {
    return { ...EMPTY_SEEN }
  }
}

export function writeRegimeSeen(map: RegimeSeenMap): void {
  try {
    localStorage.setItem(REGIME_SEEN_KEY, JSON.stringify(map))
  } catch {
    /* degrade silently */
  }
}

// -- rules -----------------------------------------------------------------

/**
 * The current state of each lens, or null where the read is unavailable.
 * 'unknown' collapses to null: a lens that cannot classify the moment has
 * not "flipped" to anything, and must not ring the bell.
 */
export function extractLensStates(regime: MacroRegimeResponse | null): RegimeSeenMap {
  if (!regime || !regime.available) return { ...EMPTY_SEEN }
  const clean = (state: string | null | undefined) =>
    !state || state === 'unknown' ? null : state
  return {
    quadrant: clean(regime.quadrant?.state),
    rate_cycle: clean(regime.rate_cycle?.state),
    risk: clean(regime.risk?.state),
    market: clean(regime.market?.state),
  }
}

/**
 * Terminal items the user has not looked at, plus one per flipped lens.
 * `lastSeen === null` means the Inbox has never been opened: every terminal
 * item is unread. A lens with no current state contributes nothing.
 */
export function computeUnread(
  items: ActivityItem[],
  lastSeen: string | null,
  regime: MacroRegimeResponse | null,
  regimeSeen: RegimeSeenMap,
): number {
  let count = 0
  for (const item of items) {
    if (!TERMINAL.has(item.status)) continue
    const stamp = item.finished_at ?? item.created_at
    if (lastSeen === null || (stamp !== null && stamp > lastSeen)) count += 1
  }
  const current = extractLensStates(regime)
  for (const lens of Object.keys(current) as RegimeLens[]) {
    const state = current[lens]
    if (state !== null && regimeSeen[lens] !== null && state !== regimeSeen[lens]) {
      count += 1
    }
  }
  return count
}

export interface RegimeFlip {
  /** `YYYY-MM` — month-end granularity, and the UI must say so. */
  month: string
  lens: RegimeLens
  from: string
  to: string
}

/** History-month field per lens; the history rows use their own key names. */
const HISTORY_FIELDS: Record<RegimeLens, keyof RegimeHistoryMonth> = {
  quadrant: 'quadrant_state',
  rate_cycle: 'rate_stage',
  risk: 'risk',
  market: 'market',
}

/**
 * Consecutive-month state changes, oldest first. A month with a null state
 * (lens unavailable then) breaks the chain rather than reading as a flip.
 */
export function deriveRegimeFlips(months: RegimeHistoryMonth[]): RegimeFlip[] {
  const flips: RegimeFlip[] = []
  for (const lens of Object.keys(HISTORY_FIELDS) as RegimeLens[]) {
    const field = HISTORY_FIELDS[lens]
    let prev: string | null = null
    for (const row of months) {
      const state = (row[field] as string | null) ?? null
      if (state !== null && state !== 'unknown') {
        if (prev !== null && state !== prev) {
          flips.push({ month: row.month, lens, from: prev, to: state })
        }
        prev = state
      } else {
        prev = null
      }
    }
  }
  flips.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
  return flips
}
