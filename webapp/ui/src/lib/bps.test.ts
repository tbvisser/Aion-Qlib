import { describe, expect, it } from 'vitest'

import { MAX_BPS, fromBps, roundTripBps, toBps } from './bps'
import { DEFAULT_STRATEGY } from './api'

describe('toBps', () => {
  it('does not leak binary floating point into the control', () => {
    // The values that misbehave are not the obvious ones — 0.0005 is exact.
    // These are not, and they are perfectly ordinary costs.
    expect(0.0003 * 10_000).not.toBe(3)
    expect(0.0029 * 10_000).not.toBe(29)

    expect(toBps(0.0003)).toBe(3)
    expect(toBps(0.0029)).toBe(29)
  })

  it('converts the defaults a new strategy starts with', () => {
    expect(toBps(DEFAULT_STRATEGY.open_cost)).toBe(5)
    expect(toBps(DEFAULT_STRATEGY.close_cost)).toBe(15)
  })

  it('maps the server ceiling onto the control ceiling', () => {
    expect(toBps(0.05)).toBe(MAX_BPS)
  })

  it('handles zero and rejects nonsense', () => {
    expect(toBps(0)).toBe(0)
    expect(toBps(NaN)).toBe(0)
    expect(toBps(Infinity)).toBe(0)
  })
})

describe('fromBps', () => {
  it('is the inverse of toBps over the values a spec actually holds', () => {
    for (const fraction of [0, 0.0001, 0.0005, 0.001, 0.0015, 0.0025, 0.01, 0.05]) {
      expect(fromBps(toBps(fraction))).toBe(fraction)
    }
  })

  it('does not perturb a spec that merely passed through the control', () => {
    // A focus/blur with no edit must produce a byte-identical spec, or every
    // visit to the form would dirty the strategy.
    const open = DEFAULT_STRATEGY.open_cost
    expect(fromBps(toBps(open))).toBe(open)
  })

  it('accepts a half-basis-point, which is a real quote', () => {
    expect(fromBps(7.5)).toBe(0.00075)
    expect(toBps(0.00075)).toBe(7.5)
  })

  it('handles zero and rejects nonsense', () => {
    expect(fromBps(0)).toBe(0)
    expect(fromBps(NaN)).toBe(0)
  })
})

describe('roundTripBps', () => {
  it('adds the two legs of a full in-and-out', () => {
    expect(roundTripBps(0.0005, 0.0015)).toBe(20)
  })

  it('stays clean where naive addition would not', () => {
    // toBps each side first, then add: adding the fractions and converting
    // once reintroduces the representation error this module exists to avoid.
    expect(roundTripBps(0.0005, 0.0005)).toBe(10)
    expect(roundTripBps(0.0001, 0.0002)).toBe(3)
  })

  it('is zero for a zero-cost ceiling run', () => {
    expect(roundTripBps(0, 0)).toBe(0)
  })
})
