import { describe, expect, it } from 'vitest'

import type { ActivityItem, MacroRelease, PortfolioRebalances } from './api'
import {
  buildAgendaEntries, countByDate, entryUnread, filterEntries, gridRange,
  groupAgenda, heatTier, monthGridWeeks, recencyFloor, resolveSelection,
  resolveView, runStats30d, splitInFlight, summarizeDays, typeCounts, weekOf,
  type AgendaSources,
} from './agenda'
import { daysBetween, isoToLocalDay } from './macroFormat'

const TODAY = '2026-08-11'

// Midday UTC instants keep the local-day mapping stable in any test timezone
// within ±11h of UTC.
const noon = (date: string) => `${date}T12:00:00+00:00`

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'run:x', source_id: 'x', kind: 'run', title: 'Momentum test', status: 'succeeded',
    created_at: noon(TODAY), started_at: null, finished_at: noon(TODAY),
    phase: null, progress: null, error: null, ...over,
  }
}

function release(over: Partial<MacroRelease>): MacroRelease {
  return {
    date: TODAY, time: '12:30', country: 'US', type: 'CPI', event_key: 'cpi',
    period: null, comparison: 'yoy', actual: null, estimate: 2.1, previous: 2.4,
    surprise: null, change: null, change_percentage: null, is_forecast: true,
    ...over,
  }
}

function sources(over: Partial<AgendaSources>): AgendaSources {
  return {
    activity: [], calendar: null, flips: [], signals: [], threads: [],
    rebalances: [], ...over,
  }
}

describe('splitInFlight', () => {
  it('separates live from terminal, and live items never reach the feed', () => {
    const items = [
      item({ id: 'run:a', status: 'running', finished_at: null }),
      item({ id: 'run:b', status: 'queued', finished_at: null }),
      item({ id: 'run:c', status: 'succeeded' }),
    ]
    const { live, done } = splitInFlight(items)
    expect(live.map((i) => i.id)).toEqual(['run:a', 'run:b'])
    expect(done.map((i) => i.id)).toEqual(['run:c'])

    const entries = buildAgendaEntries(sources({ activity: items }), TODAY)
    expect(entries.map((e) => e.key)).toEqual(['act:run:c'])
  })
})

describe('buildAgendaEntries', () => {
  it('maps runs to trade and jobs to process', () => {
    const entries = buildAgendaEntries(sources({
      activity: [
        item({ id: 'run:a' }),
        item({ id: 'ingest:b', kind: 'ingest', title: 'Data refresh' }),
        item({ id: 'macro:c', kind: 'macro_refresh', title: 'Macro refresh' }),
      ],
    }), TODAY)
    const types = Object.fromEntries(entries.map((e) => [e.key, e.type]))
    expect(types['act:run:a']).toBe('trade')
    expect(types['act:ingest:b']).toBe('process')
    expect(types['act:macro:c']).toBe('process')
  })

  it('restart_required emits both the process entry and a notification', () => {
    const entries = buildAgendaEntries(sources({
      activity: [item({ id: 'ingest:b', kind: 'ingest', restart_required: true })],
    }), TODAY)
    expect(entries.map((e) => e.type).sort()).toEqual(['notification', 'process'])
  })

  it('passes releases through untouched — surprise never fabricated', () => {
    const entries = buildAgendaEntries(sources({
      calendar: { past: [], upcoming: [release({ estimate: null })], stale: false },
    }), TODAY)
    expect(entries).toHaveLength(1)
    const payload = entries[0].payload
    if (payload.kind !== 'release') throw new Error('expected a release payload')
    expect(payload.release.surprise).toBeNull()
    expect(payload.release.estimate).toBeNull()
  })

  it('clips every source to the −14d..+7d window', () => {
    const entries = buildAgendaEntries(sources({
      calendar: {
        past: [release({ date: '2026-07-01' })],
        upcoming: [release({ date: '2026-09-15' }), release({ date: '2026-08-15' })],
        stale: false,
      },
      threads: [{ id: 't1', title: 'old', updated_at: noon('2026-06-01') }],
    }), TODAY)
    expect(entries.map((e) => e.date)).toEqual(['2026-08-15'])
  })

  it('pins a current-month flip to today and a previous-month flip to its month end', () => {
    const entries = buildAgendaEntries(sources({
      flips: [
        { month: '2026-08', lens: 'risk', from: 'risk_on', to: 'risk_off' },
        { month: '2026-07', lens: 'quadrant', from: 'reflation', to: 'stagflation' },
        { month: '2026-05', lens: 'market', from: 'calm', to: 'stressed' },
      ],
    }), TODAY)
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]))
    expect(byKey['note:flip:2026-08:risk'].date).toBe(TODAY)
    expect(byKey['note:flip:2026-07:quadrant'].date).toBe('2026-07-31')
    expect(byKey['note:flip:2026-05:market']).toBeUndefined()
    expect(byKey['note:flip:2026-08:risk'].monthGranular).toBe(true)
  })

  it('a stale calendar adds one notification on today', () => {
    const entries = buildAgendaEntries(sources({
      calendar: { past: [], upcoming: [], stale: true },
    }), TODAY)
    expect(entries).toEqual([expect.objectContaining({
      key: 'note:stale', date: TODAY, type: 'notification',
    })])
  })

  it('rebalances become dated trade entries with turnover detail', () => {
    const book: PortfolioRebalances = {
      portfolio_id: 'p1', name: '60/40', rebalance: 'monthly',
      rebalances: [{ date: '2026-07-31', turnover: 0.083, cost: 0.0001 }],
    }
    const entries = buildAgendaEntries(sources({ rebalances: [book] }), TODAY)
    expect(entries).toEqual([expect.objectContaining({
      key: 'reb:p1:2026-07-31', type: 'trade', date: '2026-07-31',
      title: '60/40 rebalanced to target',
      detail: 'monthly rule · turnover 8.3%',
      href: '/book/p1',
    })])
  })

  it('keys are unique across sources sharing ids', () => {
    const entries = buildAgendaEntries(sources({
      activity: [item({ id: 'run:a', source_id: 'a' })],
      signals: [{ runId: 'a', runTitle: 'Momentum test', date: TODAY, top: [] }],
      threads: [{ id: 'a', title: 'chat', updated_at: noon(TODAY) }],
    }), TODAY)
    const keys = entries.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('groupAgenda', () => {
  it('anchors today, sorts upcoming ascending and earlier descending, omits empty days', () => {
    const entries = buildAgendaEntries(sources({
      calendar: {
        past: [release({ date: '2026-08-05' }), release({ date: '2026-08-08' })],
        upcoming: [release({ date: '2026-08-14' }), release({ date: '2026-08-12' })],
        stale: false,
      },
    }), TODAY)
    const grouped = groupAgenda(entries, TODAY)
    expect(grouped.today.date).toBe(TODAY)
    expect(grouped.today.entries).toEqual([])
    expect(grouped.upcoming.map((d) => d.date)).toEqual(['2026-08-12', '2026-08-14'])
    expect(grouped.earlier.map((d) => d.date)).toEqual(['2026-08-08', '2026-08-05'])
    expect(grouped.today.label).toBe('Today')
    expect(grouped.upcoming[0].label).toBe('Tomorrow')
  })

  it('orders a day: timed entries first ascending, then instants ascending', () => {
    const entries = buildAgendaEntries(sources({
      activity: [
        item({ id: 'run:late', finished_at: `${TODAY}T15:00:00+00:00` }),
        item({ id: 'run:early', finished_at: `${TODAY}T09:00:00+00:00` }),
      ],
      calendar: {
        past: [],
        upcoming: [release({ time: '14:30' }), release({ time: '08:30', type: 'PPI', event_key: 'ppi' })],
        stale: false,
      },
    }), TODAY)
    const day = groupAgenda(entries, TODAY).today
    expect(day.entries.map((e) => e.key)).toEqual([
      `rel:ppi:US:${TODAY}:08:30`,
      `rel:cpi:US:${TODAY}:14:30`,
      'act:run:early',
      'act:run:late',
    ])
  })
})

describe('filter and counts', () => {
  it('counts by type and filters without recounting', () => {
    const entries = buildAgendaEntries(sources({
      activity: [item({ id: 'run:a' }), item({ id: 'ingest:b', kind: 'ingest' })],
      calendar: { past: [], upcoming: [release({})], stale: false },
    }), TODAY)
    const counts = typeCounts(entries)
    expect(counts.trade).toBe(1)
    expect(counts.process).toBe(1)
    expect(counts.release).toBe(1)
    expect(filterEntries(entries, 'trade').map((e) => e.key)).toEqual(['act:run:a'])
    expect(filterEntries(entries, 'all')).toHaveLength(entries.length)
  })
})

describe('entryUnread', () => {
  const build = (over: Partial<AgendaSources>) => buildAgendaEntries(sources(over), TODAY)

  it('null prevLastSeen makes finished work unread, but never releases', () => {
    const [act] = build({ activity: [item({})] })
    const [rel] = build({ calendar: { past: [], upcoming: [release({})], stale: false } })
    expect(entryUnread(act, null)).toBe(true)
    expect(entryUnread(rel, null)).toBe(false)
  })

  it('compares finished_at against prevLastSeen', () => {
    const [act] = build({ activity: [item({ finished_at: noon(TODAY) })] })
    expect(entryUnread(act, `${TODAY}T00:00:00+00:00`)).toBe(true)
    expect(entryUnread(act, `${TODAY}T23:00:00+00:00`)).toBe(false)
  })

  it('threads and signals are never unread-tinted', () => {
    const [msg] = build({ threads: [{ id: 't', title: 'chat', updated_at: noon(TODAY) }] })
    const [sig] = build({ signals: [{ runId: 'r', runTitle: 'x', date: TODAY, top: [] }] })
    expect(entryUnread(msg, null)).toBe(false)
    expect(entryUnread(sig, null)).toBe(false)
  })
})

describe('isoToLocalDay', () => {
  it('buckets an instant onto the viewer-local day', () => {
    // Built from local components, so the expectation holds in any timezone.
    const local = new Date(2026, 7, 11, 23, 30)
    expect(isoToLocalDay(local.toISOString())).toBe('2026-08-11')
  })
})

describe('buildAgendaEntries window parameter', () => {
  it('a custom window admits entries beyond the default and clips beyond itself', () => {
    const cal = {
      past: [release({ date: '2026-07-05' })],   // outside default −14d
      upcoming: [release({ date: '2026-09-20' })], // outside custom window
      stale: false,
    }
    const wide = buildAgendaEntries(
      sources({ calendar: cal }), TODAY, { from: '2026-07-01', to: '2026-08-18' },
    )
    expect(wide.map((e) => e.date)).toEqual(['2026-07-05'])
    // Omitting the window reproduces the default −14..+7 behavior.
    expect(buildAgendaEntries(sources({ calendar: cal }), TODAY)).toEqual([])
  })
})

describe('monthGridWeeks / gridRange', () => {
  it('a month starting Monday has no leading out-month cells', () => {
    const weeks = monthGridWeeks('2026-06') // 1 June 2026 is a Monday
    expect(weeks[0][0]).toBe('2026-06-01')
    expect(weeks.at(-1)![6]).toBe('2026-07-05')
  })

  it('a month starting Sunday gets six leading out-month cells', () => {
    const weeks = monthGridWeeks('2026-02') // 1 Feb 2026 is a Sunday
    expect(weeks[0]).toEqual([
      '2026-01-26', '2026-01-27', '2026-01-28', '2026-01-29',
      '2026-01-30', '2026-01-31', '2026-02-01',
    ])
  })

  it('a 28-day month starting Monday is exactly four rows', () => {
    const weeks = monthGridWeeks('2027-02') // 1 Feb 2027 is a Monday
    expect(weeks).toHaveLength(4)
    expect(weeks[0][0]).toBe('2027-02-01')
    expect(weeks[3][6]).toBe('2027-02-28')
  })

  it('a 31-day month starting Saturday needs six rows', () => {
    const weeks = monthGridWeeks('2026-08') // 1 Aug 2026 is a Saturday
    expect(weeks).toHaveLength(6)
  })

  it('every row has seven contiguous dates and leap February keeps the 29th', () => {
    const weeks = monthGridWeeks('2028-02')
    for (const week of weeks) expect(week).toHaveLength(7)
    expect(weeks.flat()).toContain('2028-02-29')
    const flat = weeks.flat()
    for (let i = 1; i < flat.length; i += 1) {
      expect(daysBetween(flat[i - 1], flat[i])).toBe(1)
    }
    expect(gridRange('2028-02')).toEqual({ from: flat[0], to: flat.at(-1) })
  })
})

describe('summarizeDays', () => {
  it('counts per day and type; failed beats succeeded beats null; releases never vote', () => {
    const entries = buildAgendaEntries(sources({
      activity: [
        item({ id: 'run:ok' }),
        item({ id: 'run:bad', status: 'failed' }),
        item({ id: 'ingest:x', kind: 'ingest' }),
      ],
      calendar: { past: [], upcoming: [release({})], stale: false },
    }), TODAY)
    const summary = summarizeDays(entries).get(TODAY)!
    expect(summary.count).toBe(4)
    expect(summary.byType.trade).toBe(2)
    expect(summary.byType.process).toBe(1)
    expect(summary.byType.release).toBe(1)
    expect(summary.runOutcome).toBe('failed')

    const releasesOnly = buildAgendaEntries(sources({
      calendar: { past: [], upcoming: [release({})], stale: false },
    }), TODAY)
    expect(summarizeDays(releasesOnly).get(TODAY)!.runOutcome).toBeNull()
  })
})

describe('heat', () => {
  it('weighs headline prints 3, standard (or unannotated) 1; only releases contribute', () => {
    const entries = buildAgendaEntries(sources({
      activity: [item({ id: 'run:bad', status: 'failed' })],
      calendar: {
        past: [],
        upcoming: [
          release({ event_key: 'inflation_rate__yoy', importance: 'headline' }),
          release({ event_key: 'rig_count', importance: 'standard', time: '13:00' }),
          release({ event_key: 'legacy_row', time: '14:00' }),
        ],
        stale: false,
      },
    }), TODAY)
    expect(summarizeDays(entries).get(TODAY)!.heat).toBe(5)
  })

  it('reads heat from the second list, so a filter cannot flatten the grid', () => {
    const all = buildAgendaEntries(sources({
      activity: [item({ id: 'run:ok', status: 'succeeded' })],
      calendar: {
        past: [],
        upcoming: [release({ event_key: 'cpi', importance: 'headline' })],
        stale: false,
      },
    }), TODAY)
    const trades = filterEntries(all, 'trade')

    // Counts describe the filtered list; heat still describes the whole day.
    const summary = summarizeDays(trades, all).get(TODAY)!
    expect(summary.heat).toBe(3)
    expect(summary.byType.release).toBe(0)
  })

  it('keeps a day that only heat knows about, with no phantom count', () => {
    const all = buildAgendaEntries(sources({
      calendar: {
        past: [],
        upcoming: [release({ event_key: 'cpi', importance: 'headline' })],
        stale: false,
      },
    }), TODAY)

    const summary = summarizeDays([], all).get(TODAY)!
    expect(summary.heat).toBe(3)
    expect(summary.count).toBe(0)
  })

  it('ladders 0 / 1-2 / 3-5 / 6+', () => {
    expect(heatTier(0)).toBe(0)
    expect(heatTier(1)).toBe(1)
    expect(heatTier(2)).toBe(1)
    expect(heatTier(3)).toBe(2)
    expect(heatTier(5)).toBe(2)
    expect(heatTier(6)).toBe(3)
    expect(heatTier(11)).toBe(3)
  })
})

describe('resolveSelection', () => {
  const entries = buildAgendaEntries(sources({
    calendar: {
      past: [],
      upcoming: [
        release({ event_key: 'inflation_rate__yoy', importance: 'headline' }),
        release({ event_key: 'rig_count', time: '13:00' }),
      ],
      stale: false,
    },
  }), TODAY)

  it('no key at all is a day selection', () => {
    expect(resolveSelection(null, entries)).toEqual({ kind: 'day' })
  })

  it('a key naming a visible row selects that entry', () => {
    const key = entries[0].key
    expect(resolveSelection(key, entries)).toEqual({ kind: 'entry', entryKey: key })
  })

  it('a key no longer on screen falls back to the day, never a dangling entry', () => {
    const key = entries[0].key
    expect(resolveSelection(key, [])).toEqual({ kind: 'day' })
    expect(resolveSelection('run:vanished', entries)).toEqual({ kind: 'day' })
  })
})

describe('marquee', () => {
  // Real feed strings, not the 3-char 'CPI' the other fixtures use: the cell
  // has to survive a 22-char median and these are what actually arrives.
  const cpiDay = (over: Partial<AgendaSources> = {}) => buildAgendaEntries(sources({
    calendar: {
      past: [],
      upcoming: [
        release({
          event_key: 'core_inflation_rate__mom', type: 'Core Inflation Rate',
          importance: 'headline', time: '12:30',
        }),
        release({
          event_key: 'core_inflation_rate__yoy', type: 'Core Inflation Rate',
          importance: 'headline', time: '12:30',
        }),
        release({
          event_key: 'inflation_rate__yoy', type: 'Inflation Rate',
          importance: 'headline', time: '12:30',
        }),
        release({
          event_key: 'mba_mortgage_applications', type: 'MBA Mortgage Applications',
          importance: 'standard', time: '11:00',
        }),
      ],
      stale: false,
    },
    ...over,
  }), TODAY)

  it('names the headline print and ignores the standard ones', () => {
    const summary = summarizeDays(cpiDay()).get(TODAY)!
    expect(summary.marquee).toBe('Core Inflation Rate')
  })

  it('counts distinct names in +N, so one print is not a crowd', () => {
    // Three headline rows, two distinct names — the MoM and YoY cuts of the
    // same print must not inflate the badge.
    expect(summarizeDays(cpiDay()).get(TODAY)!.marqueeMore).toBe(1)
  })

  it('an earlier headline wins over a later one', () => {
    const entries = buildAgendaEntries(sources({
      calendar: {
        past: [],
        upcoming: [
          release({
            event_key: 'retail_sales__yoy', type: 'Retail Sales',
            importance: 'headline', time: '14:00',
          }),
          release({
            event_key: 'non_farm_payrolls', type: 'Non Farm Payrolls',
            importance: 'headline', time: '08:30',
          }),
        ],
        stale: false,
      },
    }), TODAY)
    const summary = summarizeDays(entries).get(TODAY)!
    expect(summary.marquee).toBe('Non Farm Payrolls')
    expect(summary.marqueeMore).toBe(1)
  })

  it('a day of only standard prints stays silent', () => {
    const entries = buildAgendaEntries(sources({
      calendar: {
        past: [],
        upcoming: [
          release({ event_key: 'redbook', type: 'Redbook', importance: 'standard' }),
          release({ event_key: 'rig_count', type: 'Baker Hughes Oil Rig Count' }),
        ],
        stale: false,
      },
    }), TODAY)
    const summary = summarizeDays(entries).get(TODAY)!
    expect(summary.marquee).toBeNull()
    expect(summary.marqueeMore).toBe(0)
  })

  it('with no releases in view at all, the day names what it does have', () => {
    const all = cpiDay({ activity: [item({ id: 'run:one', status: 'succeeded' })] })
    const trades = filterEntries(all, 'trade')
    // A trades-only filter must not blank every cell in the month.
    expect(summarizeDays(trades, all).get(TODAY)!.marquee).not.toBeNull()
  })

  it('a day that exists only through heat is never named', () => {
    const all = cpiDay()
    // Nothing visible, but heat still registers the macro load.
    const summary = summarizeDays([], all).get(TODAY)!
    expect(summary.marquee).toBeNull()
    expect(summary.heat).toBeGreaterThan(0)
  })
})

describe('resolveView', () => {
  it('accepts week and repairs everything else to month', () => {
    expect(resolveView('week')).toBe('week')
    expect(resolveView('month')).toBe('month')
    expect(resolveView(null)).toBe('month')
    expect(resolveView('quarter')).toBe('month')
  })
})

describe('weekOf', () => {
  it('returns the Mon–Sun week containing the date', () => {
    expect(weekOf('2026-08-11')).toEqual([ // a Tuesday
      '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13',
      '2026-08-14', '2026-08-15', '2026-08-16',
    ])
  })

  it('crosses month and year boundaries', () => {
    expect(weekOf('2026-01-01')[0]).toBe('2025-12-29')
    expect(weekOf('2025-12-29')).toEqual(weekOf('2026-01-04'))
  })
})

describe('recencyFloor', () => {
  it('is null with only releases, else the oldest non-release day', () => {
    const releasesOnly = buildAgendaEntries(sources({
      calendar: { past: [release({ date: '2026-08-01' })], upcoming: [], stale: false },
    }), TODAY)
    expect(recencyFloor(releasesOnly)).toBeNull()

    const mixed = buildAgendaEntries(sources({
      activity: [
        item({ id: 'run:a', finished_at: noon('2026-08-03') }),
        item({ id: 'run:b', finished_at: noon('2026-08-09') }),
      ],
      threads: [{ id: 't', title: 'chat', updated_at: noon('2026-08-06') }],
    }), TODAY)
    expect(recencyFloor(mixed)).toBe('2026-08-03')
  })
})

describe('countByDate / runStats30d', () => {
  it('counts rows per date', () => {
    const counts = countByDate([
      { date: '2026-08-11' }, { date: '2026-08-11' }, { date: '2026-08-12' },
    ])
    expect(counts.get('2026-08-11')).toBe(2)
    expect(counts.get('2026-08-12')).toBe(1)
  })

  it('runStats30d counts only terminal runs inside 30 days', () => {
    const stats = runStats30d([
      item({ id: 'run:a' }),
      item({ id: 'run:b', status: 'failed' }),
      item({ id: 'run:c', status: 'cancelled' }),
      item({ id: 'run:old', finished_at: noon('2026-06-01') }),
      item({ id: 'ingest:x', kind: 'ingest' }),
      item({ id: 'run:live', status: 'running', finished_at: null, created_at: null }),
    ], TODAY)
    expect(stats).toEqual({ succeeded: 1, failed: 1 })
  })
})
