import { describe, expect, it } from 'vitest'

import { agendaSummary, type AgendaSummaryInput } from './agendaSummary'
import type { MacroCalendar, MacroRelease, PortfolioRebalances } from './api'

const TODAY = '2026-08-12'

function release(over: Partial<MacroRelease> = {}): MacroRelease {
  return {
    date: '2026-08-13',
    time: null,
    country: 'US',
    type: 'CPI',
    event_key: 'us-cpi',
    period: null,
    comparison: null,
    actual: null,
    estimate: null,
    previous: null,
    surprise: null,
    change: null,
    change_percentage: null,
    importance: 'standard',
    is_forecast: true,
    ...over,
  }
}

function calendar(over: Partial<MacroCalendar> = {}): MacroCalendar {
  return {
    available: true,
    fetched_at: '2026-08-12T06:00:00+00:00',
    age_seconds: 60,
    stale: false,
    past: [],
    upcoming: [],
    ...over,
  }
}

function book(dates: string[]): PortfolioRebalances {
  return {
    portfolio_id: `book-${dates.join('')}`,
    name: 'Core',
    rebalance: 'monthly',
    rebalances: dates.map((date) => ({ date, turnover: 0.1, cost: 0.0004 })),
  }
}

function input(over: Partial<AgendaSummaryInput> = {}): AgendaSummaryInput {
  return {
    calendar: calendar(),
    runStats: { succeeded: 0, failed: 0 },
    rebalances: [],
    month: '2026-08',
    unreadCount: 0,
    activityCapped: false,
    rebalanceLimit: 5,
    activityLimit: 200,
    today: TODAY,
    ...over,
  }
}

const rowFor = (label: string, over: Partial<AgendaSummaryInput> = {}) => {
  const row = agendaSummary(input(over)).find((r) => r.label.startsWith(label))
  if (!row) throw new Error(`no row starting with ${label}`)
  return row
}

describe('agendaSummary', () => {
  it('returns the four rows in a stable order', () => {
    expect(agendaSummary(input()).map((r) => r.label)).toEqual([
      'Releases · next 7d',
      'Backtests · 30d',
      'Rebalances · Aug 2026',
      'Unread',
    ])
  })
})

describe('the releases row', () => {
  it('reads an em dash, not a zero, when the calendar is not cached', () => {
    const row = rowFor('Releases', { calendar: calendar({ available: false }) })
    expect(row.value).toBe('—')
    expect(row.footnote).toBe('calendar not cached yet')
  })

  it('is also an em dash when no calendar has arrived yet', () => {
    expect(rowFor('Releases', { calendar: null }).value).toBe('—')
  })

  it('counts only the promised week, though the fetch spans more', () => {
    const row = rowFor('Releases', {
      calendar: calendar({
        upcoming: [
          release({ date: '2026-08-12' }), // today — counts
          release({ date: '2026-08-19' }), // +7 — the last day it promises
          release({ date: '2026-08-20' }), // +8 — in the fetch, out of the claim
          release({ date: '2026-09-30' }),
        ],
      }),
    })
    expect(row.value).toBe('2')
  })

  it('names the headline count when there is one, and stays silent otherwise', () => {
    expect(rowFor('Releases', {
      calendar: calendar({
        upcoming: [release({ importance: 'headline' }), release({ importance: 'low' })],
      }),
    }).sub).toBe('1 headline')

    expect(rowFor('Releases', {
      calendar: calendar({ upcoming: [release({ importance: 'low' })] }),
    }).sub).toBeUndefined()
  })

  it('carries the staleness the cache reports', () => {
    expect(rowFor('Releases', { calendar: calendar({ stale: true }) }).footnote)
      .toBe('calendar may be behind')
  })
})

describe('the backtests row', () => {
  it('reads an em dash when the window holds no finished runs', () => {
    const row = rowFor('Backtests')
    expect(row.value).toBe('—')
    expect(row.sub).toBe('none in window')
  })

  it('shows successes and names failures', () => {
    expect(rowFor('Backtests', { runStats: { succeeded: 8, failed: 0 } }))
      .toMatchObject({ value: '8', sub: 'all passed' })
    expect(rowFor('Backtests', { runStats: { succeeded: 8, failed: 3 } }))
      .toMatchObject({ value: '8', sub: '3 failed' })
  })

  it('names the feed cap it might have been truncated by', () => {
    expect(rowFor('Backtests', {
      runStats: { succeeded: 1, failed: 0 },
      activityCapped: true,
      activityLimit: 200,
    }).footnote).toBe('last 200 events')
  })
})

describe('the rebalances row', () => {
  it('counts only the viewed month, across every book', () => {
    const over = {
      rebalances: [book(['2026-08-03', '2026-07-30']), book(['2026-08-28'])],
    }
    expect(rowFor('Rebalances', over)).toMatchObject({ value: '2', sub: '2 of 2 books' })
    expect(rowFor('Rebalances', { ...over, month: '2026-07' }))
      .toMatchObject({ value: '1', sub: '1 of 2 books' })
  })

  it('labels itself with the month it counted, not with today', () => {
    expect(rowFor('Rebalances', { month: '2026-05' }).label).toBe('Rebalances · May 2026')
  })

  it('says "book" for one and "books" for more', () => {
    expect(rowFor('Rebalances', { rebalances: [book(['2026-08-03'])] }).sub)
      .toBe('1 of 1 book')
  })

  it('footnotes the per-book cap only when a full reply sat wholly in the month', () => {
    const full = ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29']
    expect(rowFor('Rebalances', { rebalances: [book(full)] }).footnote)
      .toBe('5 most recent per book')

    // The same five, but one falls outside — the month ended the list, not the cap.
    const spilling = [...full.slice(1), '2026-07-25']
    expect(rowFor('Rebalances', { rebalances: [book(spilling)] }).footnote).toBeUndefined()
  })

  it('stays silent about books when there are none', () => {
    expect(rowFor('Rebalances').sub).toBeUndefined()
  })
})

describe('the unread row', () => {
  it('says so when there is nothing to read', () => {
    expect(rowFor('Unread')).toMatchObject({ value: '0', sub: 'all caught up' })
  })

  it('drops the reassurance once there is something', () => {
    expect(rowFor('Unread', { unreadCount: 4 })).toMatchObject({ value: '4', sub: undefined })
  })
})
