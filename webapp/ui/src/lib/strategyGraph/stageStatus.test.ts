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

  it('carry the advisory tier separately, without the blocker in it', () => {
    // The inspector rail prints blockers from its own prop; `advisories` is
    // what it prints beneath them, so a blocker appearing there would be said
    // twice on the same rail.
    const collision = '`MA5` is already a column in Alpha158.'
    const status = stageStatus(routeWarnings([collision], [{ name: 'MA5' }]), {
      coverage: coverage({ feature_partial_fields: ['vwap'] }),
      unfinished: 1,
    })
    expect(status.features.advisories).toHaveLength(2)
    expect(status.features.advisories).not.toContain(collision)
    // And on an unblocked stage the two lists agree.
    const calm = stageStatus([], { unfinished: 1 })
    expect(calm.features.advisories).toEqual(calm.features.notes)
  })

  it('leave an unrouted warning off every card', () => {
    const status = stageStatus(routeWarnings(['something a future server said']))
    for (const badge of Object.values(status)) expect(badge.status).toBe('ok')
  })
})

/**
 * `validate_execution` is the first tier of preview warning that does not block.
 *
 * This module read every routed warning as a blocker while no such tier existed,
 * so wiring one in produced a card marked "1 blocking", a clay hub and — through
 * `stageEdges` — every downstream edge drawn as a run that stops, all for a
 * strategy that runs fine. These pin the severity where it is consumed.
 */
describe('execution advisories', () => {
  const NO_FILL_GUARD = 'Nothing caps a daily move on this store, so a bad tick is '
    + 'filled at full size. limit_threshold is the guard, as a fraction (0.5 blocks '
    + 'moves beyond 50% in a day).'
  const ONE_NAME = 'Holding one name makes the result a property of the single '
    + 'highest-scoring symbol each day rather than of the signal.'

  it('mark the card for attention, never as blocked', () => {
    const status = stageStatus(routeWarnings([NO_FILL_GUARD, ONE_NAME]))
    expect(status.costs.status).toBe('attention')
    expect(status.costs.notes).toEqual([NO_FILL_GUARD])
    expect(status.portfolio.status).toBe('attention')
    expect(status.portfolio.notes).toEqual([ONE_NAME])
  })

  it('leave the run unblocked, so no edge downstream is broken', () => {
    const status = stageStatus(routeWarnings([NO_FILL_GUARD, ONE_NAME]))
    expect(firstBlockedStage(status)).toBeNull()
  })

  it('sit ahead of coverage on the same stage — the spec before the store', () => {
    const status = stageStatus(routeWarnings([NO_FILL_GUARD]), {
      coverage: coverage({ feature_partial_fields: ['vwap'] }),
    })
    expect(status.costs.notes).toEqual([NO_FILL_GUARD])
    expect(status.features.status).toBe('attention')
  })

  it('still lose to a real blocker on the same stage', () => {
    const status = stageStatus(routeWarnings([NO_FILL_GUARD, TEST_OVERLAP]))
    expect(status.periods.status).toBe('blocked')
    expect(status.costs.status).toBe('attention')
    expect(firstBlockedStage(status)).toBe('periods')
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
