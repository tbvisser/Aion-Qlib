import { describe, expect, it } from 'vitest'
import type { MacroGroup, MacroSeriesResponse, MacroSnapshot } from './api'
import { boardGroupFor, buildBoard } from './macroBoard'

const KEYS: Record<MacroGroup, string[]> = {
  rates: ['US3M', 'US2Y', 'US5Y', 'US10Y', 'US30Y', 'SLOPE_2S10S', 'SLOPE_3M10Y'],
  inflation: ['BREAKEVEN_PROXY', 'CPI_YOY_US'],
  growth: ['GSPC', 'NDX', 'DJI', 'STOXX', 'N225', 'HSI', 'COPPER_GOLD'],
  volatility: ['VIX', 'VXN', 'MOVE', 'GVZ', 'OVX'],
  dollar: ['DXY', 'AXY', 'CXY'],
  commodities: ['BCOM', 'BCOMCL', 'BCOMGC', 'BCOMHG', 'BCOMNG'],
  credit: ['CREDIT_HY_IG', 'CREDIT_HY_UST'],
}

function registry(extra: { key: string; group: string }[] = []): MacroSeriesResponse {
  const groups = Object.entries(KEYS).map(([group, keys]) => ({
    group: group as MacroGroup,
    label: group,
    series: keys.map((key) => ({
      key, label: key, group: group as MacroGroup, unit: 'index' as const,
      change_unit: 'log' as const, source: 'market', derived: false,
      in_basket: false, daily_ok: true, note: '', available: true, reason: null,
    })),
  }))
  for (const item of extra) {
    groups.push({
      group: item.group as MacroGroup, label: item.group,
      series: [{
        key: item.key, label: item.key, group: item.group as MacroGroup,
        unit: 'index' as const, change_unit: 'log' as const, source: 'market',
        derived: false, in_basket: false, daily_ok: true, note: '',
        available: true, reason: null,
      }],
    })
  }
  return { groups, basket: [], count: 31, available: 31 }
}

const ALL_KEYS = Object.values(KEYS).flat()

describe('buildBoard', () => {
  it('places every registry series in exactly one group', () => {
    const board = buildBoard(registry(), null, '1d')
    const placed = board.flatMap((g) => g.rows.map((r) => r.key))
    expect(new Set(placed)).toEqual(new Set(ALL_KEYS))
    expect(placed).toHaveLength(ALL_KEYS.length)
  })

  it('yields six groups of four to six rows, which tile as a rectangle', () => {
    // The registry's own seven groups hold 2-7 and cannot fill a grid at any
    // column count — that is the ragged-grid bug this mapping fixes.
    const board = buildBoard(registry(), null, '1d')
    expect(board).toHaveLength(6)
    for (const group of board) {
      expect(group.rows.length).toBeGreaterThanOrEqual(4)
      expect(group.rows.length).toBeLessThanOrEqual(6)
    }
  })

  it('groups the spreads together and copper/gold with its legs', () => {
    expect(boardGroupFor('SLOPE_2S10S', 'rates')).toBe('curve_credit')
    expect(boardGroupFor('SLOPE_3M10Y', 'rates')).toBe('curve_credit')
    expect(boardGroupFor('COPPER_GOLD', 'growth')).toBe('commodities')
    expect(boardGroupFor('US10Y', 'rates')).toBe('rates')
  })

  it('never drops a series it does not recognise', () => {
    // A shorter list would read as "this desk does not track the dollar".
    const board = buildBoard(registry([{ key: 'NEWTHING', group: 'quantum' }]), null, '1d')
    const other = board.find((g) => g.id === 'other')
    expect(other?.rows.map((r) => r.key)).toEqual(['NEWTHING'])
  })

  it('keeps unavailable series, carrying their reason', () => {
    const base = registry()
    base.groups[0].series[0] = {
      ...base.groups[0].series[0], available: false, reason: 'no data on disk',
    }
    const row = buildBoard(base, null, '1d')
      .flatMap((g) => g.rows).find((r) => r.key === 'US3M')
    expect(row?.available).toBe(false)
    expect(row?.reason).toBe('no data on disk')
    expect(row?.level).toBeNull()
  })

  it('selects the change for the requested horizon', () => {
    const snapshot = {
      as_of: '2026-08-07', available: true, groups: [],
      rows: [{
        key: 'US10Y', label: 'US10Y', group: 'rates' as MacroGroup,
        unit: 'percent' as const, change_unit: 'bps' as const,
        available: true, reason: null, as_of: '2026-08-07', level: 4.65,
        change_1d: 1, change_1w: 2, change_1m: 3, change_1y: 4,
        zscore: 1.2, spark: [1, 2, 3],
      }],
    } as unknown as MacroSnapshot

    for (const [horizon, expected] of [['1d', 1], ['1w', 2], ['1m', 3], ['1y', 4]] as const) {
      const row = buildBoard(registry(), snapshot, horizon)
        .flatMap((g) => g.rows).find((r) => r.key === 'US10Y')
      expect(row?.change).toBe(expected)
    }
  })

  it('renders rows with nulls when the snapshot is missing them', () => {
    const board = buildBoard(registry(), null, '1d')
    const rows = board.flatMap((g) => g.rows)
    expect(rows).toHaveLength(ALL_KEYS.length)
    expect(rows.every((r) => r.level === null && r.spark.length === 0)).toBe(true)
  })

  it('is empty without a registry', () => {
    expect(buildBoard(null, null, '1d')).toEqual([])
  })
})
