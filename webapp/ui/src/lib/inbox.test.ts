import { describe, expect, it } from 'vitest'

import type { ActivityItem, MacroRegimeResponse, RegimeHistoryMonth } from './api'
import { computeUnread, deriveRegimeFlips, extractLensStates } from './inbox'

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'run:x', source_id: 'x', kind: 'run', title: 'x', status: 'succeeded',
    created_at: '2026-08-11T10:00:00+00:00', started_at: null,
    finished_at: '2026-08-11T10:05:00+00:00', phase: null, progress: null,
    error: null, ...over,
  }
}

function regime(states: {
  quadrant?: string; rate_cycle?: string; risk?: string; market?: string
  available?: boolean
}): MacroRegimeResponse {
  return {
    available: states.available ?? true,
    quadrant: { state: states.quadrant ?? 'unknown' },
    rate_cycle: { state: states.rate_cycle ?? 'unknown' },
    risk: { state: states.risk ?? 'unknown' },
    market: { state: states.market ?? 'unknown' },
  } as MacroRegimeResponse
}

const seen = (over: Partial<Record<string, string | null>> = {}) => ({
  quadrant: null, rate_cycle: null, risk: null, market: null, ...over,
}) as ReturnType<typeof extractLensStates>

describe('computeUnread', () => {
  it('counts every terminal item when the inbox has never been opened', () => {
    const items = [item({}), item({ id: 'run:y', status: 'failed' }),
                   item({ id: 'run:z', status: 'running', finished_at: null })]
    expect(computeUnread(items, null, null, seen())).toBe(2)
  })

  it('counts only items finishing after lastSeen', () => {
    const items = [
      item({ finished_at: '2026-08-11T09:00:00+00:00' }),
      item({ id: 'run:y', finished_at: '2026-08-11T11:00:00+00:00' }),
    ]
    expect(computeUnread(items, '2026-08-11T10:00:00+00:00', null, seen())).toBe(1)
  })

  it('falls back to created_at when finished_at is missing', () => {
    const items = [item({ finished_at: null, created_at: '2026-08-11T11:00:00+00:00' })]
    expect(computeUnread(items, '2026-08-11T10:00:00+00:00', null, seen())).toBe(1)
  })

  it('running and queued items are never unread — they are not news yet', () => {
    const items = [item({ status: 'running', finished_at: null }),
                   item({ id: 'run:y', status: 'queued', finished_at: null })]
    expect(computeUnread(items, null, null, seen())).toBe(0)
  })

  it('adds one per flipped regime lens', () => {
    const current = regime({ quadrant: 'reflation', risk: 'risk_on' })
    const last = seen({ quadrant: 'stagflation', risk: 'risk_on' })
    expect(computeUnread([], '2026-08-11T00:00:00+00:00', current, last)).toBe(1)
  })

  it('a lens never seen before is not a flip', () => {
    const current = regime({ quadrant: 'reflation' })
    expect(computeUnread([], '2026-08-11T00:00:00+00:00', current, seen())).toBe(0)
  })

  it('an unavailable regime contributes nothing', () => {
    const current = regime({ quadrant: 'reflation', available: false })
    const last = seen({ quadrant: 'stagflation' })
    expect(computeUnread([], '2026-08-11T00:00:00+00:00', current, last)).toBe(0)
  })

  it('an unknown lens state is treated as absent, not as a flip', () => {
    const current = regime({ quadrant: 'unknown' })
    const last = seen({ quadrant: 'reflation' })
    expect(computeUnread([], '2026-08-11T00:00:00+00:00', current, last)).toBe(0)
  })
})

describe('deriveRegimeFlips', () => {
  const month = (m: string, over: Partial<RegimeHistoryMonth> = {}): RegimeHistoryMonth => ({
    month: m, quadrant: null, quadrant_state: null, rate_stage: null,
    risk: null, market: null, ...over,
  })

  it('reports consecutive-month state changes per lens', () => {
    const months = [
      month('2026-05', { quadrant_state: 'reflation', risk: 'risk_on' }),
      month('2026-06', { quadrant_state: 'reflation', risk: 'risk_off' }),
      month('2026-07', { quadrant_state: 'stagflation', risk: 'risk_off' }),
    ]
    expect(deriveRegimeFlips(months)).toEqual([
      { month: '2026-06', lens: 'risk', from: 'risk_on', to: 'risk_off' },
      { month: '2026-07', lens: 'quadrant', from: 'reflation', to: 'stagflation' },
    ])
  })

  it('a null month breaks the chain instead of reading as a flip', () => {
    const months = [
      month('2026-05', { rate_stage: 'hiking' }),
      month('2026-06', {}),
      month('2026-07', { rate_stage: 'cutting' }),
    ]
    expect(deriveRegimeFlips(months)).toEqual([])
  })

  it('a steady state produces no flips', () => {
    const months = [
      month('2026-06', { market: 'calm' }),
      month('2026-07', { market: 'calm' }),
    ]
    expect(deriveRegimeFlips(months)).toEqual([])
  })
})

describe('extractLensStates', () => {
  it('collapses unknown to null', () => {
    const states = extractLensStates(regime({ quadrant: 'reflation' }))
    expect(states.quadrant).toBe('reflation')
    expect(states.risk).toBeNull()
  })

  it('returns all-null when unavailable', () => {
    const states = extractLensStates(regime({ quadrant: 'reflation', available: false }))
    expect(states.quadrant).toBeNull()
  })
})
