import { describe, expect, it } from 'vitest'

import { DEFAULT_STRATEGY, type DataStore, type StrategySpec } from '@/lib/api'
import { stageGlance, type GlanceLine } from './glance'
import { STAGE_ORDER } from './stages'

const spec = (over: Partial<StrategySpec> = {}): StrategySpec => ({ ...DEFAULT_STRATEGY, ...over })

const store = (over: Partial<DataStore> = {}): DataStore => ({
  key: 'us',
  label: 'US equities',
  provider_uri: '/data/us',
  region: 'us',
  note: '',
  exists: true,
  calendar_days: 4102,
  universes: ['top500'],
  calendar_start: '2010-01-04',
  calendar_end: '2026-08-07',
  benchmarks: ['SPY'],
  mounted: true,
  ...over,
})

const values = (lines: GlanceLine[]) => lines.map((l) => l.value)
const find = (lines: GlanceLine[], key: string) => lines.find((l) => l.key === key)

describe('every stage', () => {
  /**
   * The headline is the card's bold line, so an empty one leaves a card with no
   * content at all. Nothing may be conditional on context that has not arrived.
   */
  it('has a headline before any context lands', () => {
    for (const id of STAGE_ORDER) {
      expect(stageGlance(id, spec()).headline).toBeTruthy()
    }
  })
})

describe('store', () => {
  it('leads with the store, and groups the calendar length as computed', () => {
    const g = stageGlance('store', spec(), { store: store() })
    expect(g.headline).toBe('us')
    expect(find(g.detail, 'days')).toMatchObject({
      value: '4,102 trading days', computed: true,
    })
  })

  it('flags an unbuilt store in clay rather than claiming a day count', () => {
    const g = stageGlance('store', spec(), { store: store({ exists: false }) })
    expect(g.headline).toBe('us')
    expect(find(g.detail, 'built')).toMatchObject({ value: 'no data yet', tone: 'clay' })
    expect(find(g.detail, 'days')).toBeUndefined()
  })

  it('prints the key alone before any store has answered', () => {
    expect(stageGlance('store', spec())).toEqual({ headline: 'us', detail: [] })
  })
})

describe('universe', () => {
  it('reads as one question: which names, against what', () => {
    expect(stageGlance('universe', spec()).headline).toBe('top500 vs SPY')
  })

  it('shows the count as a computed detail', () => {
    const g = stageGlance('universe', spec(), { universeCount: 500 })
    expect(find(g.detail, 'count')).toMatchObject({ value: '500 names', computed: true })
  })

  it('says nothing rather than "null names" when the count is unknown', () => {
    expect(stageGlance('universe', spec(), { universeCount: null }).detail).toEqual([])
    expect(stageGlance('universe', spec()).detail).toEqual([])
  })

  it('does not hide a genuinely empty universe', () => {
    expect(values(stageGlance('universe', spec(), { universeCount: 0 }).detail))
      .toEqual(['0 names'])
  })
})

describe('features', () => {
  it('leads with the handler when there are no own columns', () => {
    const g = stageGlance('features', spec({ features: null }))
    expect(g.headline).toBe('Alpha158')
    expect(values(g.detail)).toEqual(['158 columns'])
  })

  it('reads the column count off the handler name', () => {
    expect(values(stageGlance('features', spec({ handler: 'Alpha360', features: null })).detail))
      .toEqual(['360 columns'])
  })

  it('does not guess a count for a handler it has never heard of', () => {
    const g = stageGlance('features', spec({ handler: 'Custom', features: null }))
    expect(g.headline).toBe('Custom')
    expect(g.detail).toEqual([])
  })

  it('adds own columns to the handler when extending, and totals them', () => {
    const features = [
      { name: 'MOM5', expression: 'a' },
      { name: 'VOL20', expression: 'b' },
      { name: 'PV', expression: 'c' },
    ]
    const g = stageGlance('features', spec({ features, feature_mode: 'extend' }))
    expect(g.headline).toBe('Alpha158 + 3')
    expect(values(g.detail)).toEqual(['161 columns'])
  })

  it('says the handler is gone when replacing', () => {
    const features = [{ name: 'MOM5', expression: 'a' }]
    const g = stageGlance('features', spec({ features, feature_mode: 'replace' }))
    expect(g.headline).toBe('1 column')
    expect(values(g.detail)).toEqual(['Alpha158 replaced'])
  })

  it('counts unfinished canvas columns separately from the spec, in clay', () => {
    const g = stageGlance('features', spec({ features: null }), { unfinished: 2 })
    expect(find(g.detail, 'unfinished')).toMatchObject({ value: '2 unfinished', tone: 'clay' })
  })
})

describe('periods', () => {
  /** The test window is the period the reported numbers came from. */
  it('leads with the test window and keeps the fit windows as detail', () => {
    const g = stageGlance('periods', spec())
    expect(g.headline).toBe('2022 → 2026')
    expect(find(g.detail, 'fit')?.value).toBe('train 2010–2019 · valid 2020–2021')
  })

  it('prints where the run really ends, and says so, when the clamp bites', () => {
    const g = stageGlance('periods', spec({ test_end: '2030-01-01' }), {
      explain: {
        label: null,
        calendar_start: '2010-01-04',
        calendar_end: '2026-08-07',
        effective_test_end: '2026-08-07',
      },
    })
    expect(g.headline).toBe('2022 → 2026')
    expect(find(g.detail, 'clamp')).toMatchObject({ value: 'store ends early', tone: 'clay' })
  })

  it('stays quiet when no clamp applies', () => {
    const g = stageGlance('periods', spec(), {
      explain: {
        label: null,
        calendar_start: '2010-01-04',
        calendar_end: '2026-08-07',
        effective_test_end: DEFAULT_STRATEGY.test_end,
      },
    })
    expect(find(g.detail, 'clamp')).toBeUndefined()
  })
})

describe('learner', () => {
  it('prefers the server label over the raw id', () => {
    const models = { models: [{ id: 'lightgbm', label: 'LightGBM', class: 'LGBModel' }], handlers: [] }
    expect(stageGlance('learner', spec(), { models }).headline).toBe('LightGBM')
  })

  it('falls back to the id before the models land', () => {
    expect(stageGlance('learner', spec()).headline).toBe('lightgbm')
  })
})

describe('portfolio', () => {
  it('names what the numbers mean', () => {
    const g = stageGlance('portfolio', spec())
    expect(g.headline).toBe('Top 50')
    expect(values(g.detail)).toEqual(['drop 5 per rebalance'])
  })
})

describe('costs', () => {
  /** The number that decides whether a strategy survives its own turnover. */
  it('leads with the round trip, which neither cost field shows', () => {
    expect(stageGlance('costs', spec()).headline).toBe('20 bps round trip')
  })

  it('groups the account', () => {
    expect(find(stageGlance('costs', spec()).detail, 'account')?.value).toBe('$100,000,000')
  })

  it('surfaces a limit threshold a template carried in', () => {
    expect(values(stageGlance('costs', spec({ limit_threshold: 0.095 })).detail))
      .toContain('limit 0.095')
  })

  it('stays silent when there is no limit', () => {
    expect(find(stageGlance('costs', spec()).detail, 'limit')).toBeUndefined()
  })
})

describe('context', () => {
  it('labels the stage as the objective', () => {
    expect(stageGlance('context', spec()).headline).toBe('Objective')
  })

  it('shows a preview of the objective when set', () => {
    const g = stageGlance('context', spec({ context: 'Lower volatility than the benchmark' }))
    expect(find(g.detail, 'context')?.value).toBe('Lower volatility than the benchmark')
  })

  it('truncates long objectives', () => {
    const long = 'a'.repeat(60)
    const g = stageGlance('context', spec({ context: long }))
    expect(find(g.detail, 'context')?.value).toBe(`${long.slice(0, 40)}…`)
  })

  it('says so when no objective is set', () => {
    expect(find(stageGlance('context', spec()).detail, 'context')?.value).toBe('No objective set')
  })
})
