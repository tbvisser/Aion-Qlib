import { describe, expect, it } from 'vitest'

import {
  advisoryFor, blockingFor, isAdvisoryWarning, routeWarnings, unroutedWarnings,
  warningsFor, EXECUTION_WARNING_ROUTES, WINDOW_WARNING_PREFIXES,
} from './routeWarning'

// The exact strings the backend emits. If `StrategySpec.validate_windows` or
// `inspect_features` drifts, this test is where it shows up rather than as a
// badge quietly appearing on the wrong card.
const TRAIN_ORDER = 'Train end is before train start.'
const VALID_OVERLAP = 'Validation overlaps training — the model would be scored on data it saw.'
const TEST_OVERLAP = 'Test overlaps validation — results would be optimistic.'
const TEST_ORDER = 'Test end is before test start.'
const CLAMP = 'Test end 2030-01-01 is past the last date this store can safely backtest; '
  + 'the run will end 2026-08-07 instead.'

const COLLISION = '`MA5` is already a column in Alpha158. Extending would replace '
  + "Alpha158's `MA5` with yours and no error would be raised anywhere."
const EMPTY_SET = "Replacing the handler's features needs at least one of your own, or "
  + 'there is nothing for the model to look at.'

const WINDOW_WARNINGS = [TRAIN_ORDER, VALID_OVERLAP, TEST_OVERLAP, TEST_ORDER, CLAMP]

// `StrategySpec.validate_execution`, verbatim. Unlike the window warnings these
// go to three different cards, because they are three different edits.
const JUNK_UNIVERSE = "Universe 'crypto' is 1913 names, most of them thinly traded, "
  + "and a single bad print in that tail can dominate a backtest. 'crypto_top100' "
  + 'is the curated list.'
const ONE_NAME = 'Holding one name makes the result a property of the single '
  + 'highest-scoring symbol each day rather than of the signal. With n_drop 0 the '
  + 'book never rotates out of a bad fill either.'
const NO_FILL_GUARD = 'Nothing caps a daily move on this store, so a bad tick is '
  + 'filled at full size. limit_threshold is the guard, as a fraction (0.5 blocks '
  + 'moves beyond 50% in a day).'

describe('execution warnings', () => {
  it('sends each one to the stage that owns the field it is about', () => {
    expect(routeWarnings([JUNK_UNIVERSE])[0].stage).toBe('universe')
    expect(routeWarnings([ONE_NAME])[0].stage).toBe('portfolio')
    expect(routeWarnings([NO_FILL_GUARD])[0].stage).toBe('costs')
  })

  it('has one route per branch of validate_execution', () => {
    expect(EXECUTION_WARNING_ROUTES).toHaveLength(3)
  })

  /**
   * The column rule is a substring match, so it runs *after* these. Without that
   * ordering a user's column named `names` would drag an unfiltered-universe
   * warning onto the Features card, which is not where the fix is.
   */
  it('beats the column rule, so a column name cannot steal one', () => {
    const columns = [{ name: 'names' }, { name: 'signal' }, { name: 'guard' }]
    expect(routeWarnings([JUNK_UNIVERSE], columns)[0].stage).toBe('universe')
    expect(routeWarnings([ONE_NAME], columns)[0].stage).toBe('portfolio')
    expect(routeWarnings([NO_FILL_GUARD], columns)[0].stage).toBe('costs')
  })

  it('does not claim a window warning', () => {
    for (const warning of WINDOW_WARNINGS) {
      expect(routeWarnings([warning])[0].stage).toBe('periods')
    }
  })

  /**
   * The severity, which is the whole reason these are a separate tier. A spec
   * that trades an unfiltered universe one name at a time runs perfectly well —
   * calling it a blocker would claim otherwise, and (via `stageEdges`) would
   * draw every stage after it as a run that stops.
   */
  it('is advisory, where a window or feature warning blocks', () => {
    for (const warning of [JUNK_UNIVERSE, ONE_NAME, NO_FILL_GUARD]) {
      expect(routeWarnings([warning])[0].advisory).toBe(true)
      expect(isAdvisoryWarning(warning)).toBe(true)
    }
    for (const warning of [...WINDOW_WARNINGS, EMPTY_SET]) {
      expect(routeWarnings([warning])[0].advisory).toBe(false)
      expect(isAdvisoryWarning(warning)).toBe(false)
    }
  })

  it('separates the two tiers for one stage', () => {
    // Contrived: both land on `costs` only if a blocker ever routes there. Uses
    // two execution warnings on different stages to prove the split is per-tier
    // and not per-stage.
    const routed = routeWarnings([NO_FILL_GUARD, TEST_OVERLAP])
    expect(advisoryFor(routed, 'costs')).toEqual([NO_FILL_GUARD])
    expect(blockingFor(routed, 'costs')).toEqual([])
    expect(blockingFor(routed, 'periods')).toEqual([TEST_OVERLAP])
    expect(advisoryFor(routed, 'periods')).toEqual([])
  })

  it('still reaches the card: advisory is a severity, not a silencer', () => {
    const routed = routeWarnings([JUNK_UNIVERSE, ONE_NAME, NO_FILL_GUARD])
    expect(warningsFor(routed, 'universe')).toEqual([JUNK_UNIVERSE])
    expect(warningsFor(routed, 'portfolio')).toEqual([ONE_NAME])
    expect(warningsFor(routed, 'costs')).toEqual([NO_FILL_GUARD])
    expect(unroutedWarnings(routed)).toEqual([])
  })
})

describe('window warnings', () => {
  it('routes every branch of validate_windows to the periods card', () => {
    for (const warning of WINDOW_WARNINGS) {
      expect(routeWarnings([warning])[0].stage).toBe('periods')
    }
  })

  it('carries one prefix per branch, so a sixth cannot be added unnoticed', () => {
    expect(WINDOW_WARNING_PREFIXES).toHaveLength(WINDOW_WARNINGS.length)
    for (const prefix of WINDOW_WARNING_PREFIXES) {
      expect(WINDOW_WARNINGS.some((w) => w.startsWith(prefix))).toBe(true)
    }
  })
})

describe('feature warnings', () => {
  it('routes a collision to the features card when the column is live', () => {
    expect(routeWarnings([COLLISION], [{ name: 'MA5' }])[0].stage).toBe('features')
  })

  it('leaves a collision unrouted when no such column exists on the canvas', () => {
    expect(routeWarnings([COLLISION], [{ name: 'MOM5' }])[0].stage).toBeNull()
  })

  it('routes the empty-set warning, which names no column at all', () => {
    expect(routeWarnings([EMPTY_SET])[0].stage).toBe('features')
  })

  /**
   * The regression the backtick rule exists for. A column legally named `a`
   * matched every warning containing the letter, so naming one column `a`
   * silently moved "Test overlaps validation" onto the Features card.
   */
  it('does not let a one-letter column name capture a window warning', () => {
    expect(routeWarnings([TEST_OVERLAP], [{ name: 'a' }])[0].stage).toBe('periods')
    expect(routeWarnings([EMPTY_SET, TEST_OVERLAP], [{ name: 'a' }]).map((r) => r.stage))
      .toEqual(['features', 'periods'])
  })

  it('ignores a blank column name', () => {
    expect(routeWarnings(['nothing in particular'], [{ name: '' }])[0].stage).toBeNull()
  })
})

describe('totality', () => {
  /**
   * The hard invariant. Removing the wall of warnings must not remove a
   * warning: a server string this module has never met still has to reach the
   * screen, page-level, rather than being swallowed by a catch-all or a filter.
   */
  it('never drops a warning', () => {
    const inputs = [
      [],
      [TEST_OVERLAP],
      [TEST_OVERLAP, COLLISION, 'something a future server said'],
      WINDOW_WARNINGS,
    ]
    for (const warnings of inputs) {
      const routed = routeWarnings(warnings, [{ name: 'MA5' }])
      expect(routed).toHaveLength(warnings.length)
      expect(routed.map((r) => r.message)).toEqual(warnings)
    }
  })

  it('sends an unrecognised warning to null, never to a fallback stage', () => {
    const routed = routeWarnings(['something a future server said'])
    expect(routed[0].stage).toBeNull()
    expect(unroutedWarnings(routed)).toEqual(['something a future server said'])
  })

  it('preserves input order within a stage', () => {
    const routed = routeWarnings([TEST_ORDER, COLLISION, TRAIN_ORDER], [{ name: 'MA5' }])
    expect(warningsFor(routed, 'periods')).toEqual([TEST_ORDER, TRAIN_ORDER])
    expect(warningsFor(routed, 'features')).toEqual([COLLISION])
    expect(warningsFor(routed, 'costs')).toEqual([])
  })
})
