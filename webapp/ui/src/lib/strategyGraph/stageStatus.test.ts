import { describe, expect, it } from 'vitest'

import type { StrategyCoverage } from '@/lib/api'
import { routeWarnings } from './routeWarning'
import { firstBlockedStage, stageStatus } from './stageStatus'

const TEST_OVERLAP = 'Test overlaps validation — results would be optimistic.'

const coverage = (over: Partial<StrategyCoverage> = {}): StrategyCoverage => ({
  store: 'us',
  checked: true,
  handler: 'Alpha158',
  model: 'lightgbm',
  dead_columns: [],
  dropped: false,
  proxy_columns: {},
  partial_columns: [],
  ...over,
})

describe('coverage never blocks', () => {
  /**
   * `CoverageBanner`'s docblock says this in prose; here it is where a test can
   * hold it. The generated config drops a dead column before training, so the
   * run is fine — it is worth knowing, not worth stopping for.
   */
  it('marks dead columns as attention on the store, not blocked', () => {
    const status = stageStatus([], { coverage: coverage({ dead_columns: ['VWAP0'], dropped: true }) })
    expect(status.store.status).toBe('attention')
    expect(status.store.notes[0]).toContain('dropped before training')
  })

  it('also flags the learner when the model is the one that feels it', () => {
    const dead = { dead_columns: ['VWAP0'] }
    expect(stageStatus([], { coverage: coverage({ ...dead, model: 'linear' }) }).learner.status)
      .toBe('attention')
    expect(stageStatus([], { coverage: coverage({ ...dead, model: 'lightgbm' }) }).learner.status)
      .toBe('ok')
  })

  it('flags partial and proxy fields on the features card', () => {
    const status = stageStatus([], {
      coverage: coverage({ feature_partial_fields: ['vwap'], feature_proxy_fields: { vwap: 'typical price' } }),
    })
    expect(status.features.status).toBe('attention')
    expect(status.features.notes).toHaveLength(2)
  })

  /** "No answer" is not "no columns" — an unread store must not read as a clean bill. */
  it('says nothing at all when the store could not be read', () => {
    const status = stageStatus([], {
      coverage: coverage({ checked: false, dead_columns: ['VWAP0'] }),
    })
    expect(status.store.status).toBe('ok')
    expect(status.store.notes).toEqual([])
  })

  it('says nothing before coverage arrives', () => {
    expect(stageStatus([]).store.status).toBe('ok')
  })
})

describe('unfinished columns', () => {
  it('are attention, not an error — they are simply not in the config yet', () => {
    const status = stageStatus([], { unfinished: 2 })
    expect(status.features.status).toBe('attention')
    expect(status.features.notes[0]).toContain('not in the config yet')
  })

  it('reads as singular for one', () => {
    expect(stageStatus([], { unfinished: 1 }).features.notes[0]).toContain('1 feature is unfinished')
  })
})

describe('blockers', () => {
  it('block the stage the warning routed to', () => {
    const status = stageStatus(routeWarnings([TEST_OVERLAP]))
    expect(status.periods.status).toBe('blocked')
    expect(status.periods.notes).toEqual([TEST_OVERLAP])
    expect(status.store.status).toBe('ok')
  })

  it('outrank coverage on the same stage, but keep the advisory note behind them', () => {
    const collision = '`MA5` is already a column in Alpha158.'
    const status = stageStatus(routeWarnings([collision], [{ name: 'MA5' }]), {
      coverage: coverage({ feature_partial_fields: ['vwap'] }),
      unfinished: 1,
    })
    expect(status.features.status).toBe('blocked')
    expect(status.features.notes[0]).toBe(collision)
    expect(status.features.notes).toHaveLength(3)
  })

  it('leave an unrouted warning off every card', () => {
    const status = stageStatus(routeWarnings(['something a future server said']))
    for (const badge of Object.values(status)) expect(badge.status).toBe('ok')
  })
})

describe('firstBlockedStage', () => {
  it('finds the earliest blocked stage in pipeline order', () => {
    const status = stageStatus(routeWarnings([TEST_OVERLAP]))
    expect(firstBlockedStage(status)).toBe('periods')
  })

  it('is null when nothing blocks', () => {
    expect(firstBlockedStage(stageStatus([], { unfinished: 3 }))).toBeNull()
  })
})
