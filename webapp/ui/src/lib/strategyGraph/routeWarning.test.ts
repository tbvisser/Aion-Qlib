import { describe, expect, it } from 'vitest'

import {
  routeWarnings, unroutedWarnings, warningsFor, WINDOW_WARNING_PREFIXES,
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
