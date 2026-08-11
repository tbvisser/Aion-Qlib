/**
 * The line used to claim "every column this handler needs is present" while
 * reading `dead_columns` alone — so it said that for a spec whose own custom
 * factors were about to end the run, and for a store whose columns were only
 * half written. The load-bearing assertion in this file is the last one: the
 * all-clear string appears in exactly one case.
 */
import { describe, expect, it } from 'vitest'

import { ALL_CLEAR, coverageLine } from '@/lib/coverageLine'
import type { StrategyCoverage } from '@/lib/api'

const clean = (over: Partial<StrategyCoverage> = {}): StrategyCoverage => ({
  store: 'us',
  checked: true,
  handler: 'Alpha158',
  model: 'lightgbm',
  dead_columns: [],
  dropped: false,
  proxy_columns: {},
  partial_columns: [],
  feature_proxy_fields: {},
  feature_partial_fields: [],
  ...over,
})

describe('coverageLine', () => {
  it('distinguishes "not asked yet" from "asked and got nothing"', () => {
    expect(coverageLine(undefined)).toBe('checking…')
    expect(coverageLine(clean({ checked: false }))).toContain('could not be read')
  })

  it('says everything is present when it is', () => {
    expect(coverageLine(clean())).toBe(ALL_CLEAR)
  })

  it('names the dead columns and the mitigation together', () => {
    const line = coverageLine(clean({ dead_columns: ['VWAP0'], dropped: true }))
    expect(line).toContain('VWAP0')
    expect(line).toContain('Alpha158')
    expect(line).toContain('dropped before training')
  })

  it('does not promise a drop that the config is not making', () => {
    const line = coverageLine(clean({ dead_columns: ['VWAP0'], dropped: false }))
    expect(line).toContain('VWAP0')
    expect(line).not.toContain('dropped before training')
  })

  it('abbreviates a long list rather than printing sixty column names', () => {
    const sixty = Array.from({ length: 60 }, (_, i) => `VWAP${i}`)
    const line = coverageLine(clean({ handler: 'Alpha360', dead_columns: sixty, dropped: true }))
    expect(line).toContain('VWAP0, VWAP1, VWAP2, +57 more')
    expect(line).toContain('60 Alpha360 columns')
  })

  it("reports a proxy field the spec's own factors read", () => {
    const line = coverageLine(clean({
      feature_proxy_fields: { vwap: "typical price, not a volume-weighted price" },
    }))
    expect(line).toContain('$vwap')
    expect(line).toContain('your factors')
    expect(line).not.toBe(ALL_CLEAR)
  })

  it("reports a partial field the spec's own factors read", () => {
    const line = coverageLine(clean({ feature_partial_fields: ['vwap'] }))
    expect(line).toContain('$vwap')
    expect(line).toContain('cross-section')
  })

  it('stays quiet about a store-wide proxy no factor reads', () => {
    // Both stores carry one, so surfacing it here would append the same clause
    // to every row of every sweep forever — the warning people learn to skip.
    expect(coverageLine(clean({ proxy_columns: { vwap: 'typical price' } }))).toBe(ALL_CLEAR)
  })

  it('reports a store-wide partial column even when no factor names it', () => {
    // Unlike the proxy, this is not true of every store, and it silently
    // shrinks the cross-section the model trades.
    expect(coverageLine(clean({ partial_columns: ['change'] }))).toContain('$change')
  })

  it('treats a server that predates the feature keys as "did not look"', () => {
    const { feature_proxy_fields, feature_partial_fields, ...older } = clean()
    void feature_proxy_fields
    void feature_partial_fields
    expect(() => coverageLine(older as StrategyCoverage)).not.toThrow()
    expect(coverageLine(older as StrategyCoverage)).toBe(ALL_CLEAR)
  })

  it('joins every problem it found rather than reporting only the worst', () => {
    const line = coverageLine(clean({
      dead_columns: ['VWAP0'],
      dropped: true,
      feature_partial_fields: ['change'],
      partial_columns: ['change'],
    }))
    expect(line).toContain('VWAP0')
    expect(line).toContain('$change')
    expect(line.split(';')).toHaveLength(3)
  })

  it('claims the all-clear in exactly one of these cases', () => {
    const cases: Partial<StrategyCoverage>[] = [
      {},
      { dead_columns: ['VWAP0'], dropped: true },
      { feature_proxy_fields: { vwap: 'x' } },
      { feature_partial_fields: ['vwap'] },
      { partial_columns: ['change'] },
    ]
    const allClear = cases.filter((c) => coverageLine(clean(c)) === ALL_CLEAR)
    expect(allClear).toHaveLength(1)
  })
})
