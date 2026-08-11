import { describe, expect, it } from 'vitest'

import { changedKeys, showValue } from './specDiff'

describe('changedKeys', () => {
  it('reports only the fields that differ', () => {
    expect(changedKeys({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, c: 3 })).toEqual(['b'])
  })

  it('keeps the left operand\'s key order rather than sorting', () => {
    // A spec's declaration order is the order it reads in. Alphabetical would
    // put `account` above `benchmark` above `close_cost`, which is nobody's
    // mental model of a strategy.
    const a = { zebra: 1, apple: 1, mango: 1 }
    const b = { zebra: 2, apple: 2, mango: 2 }
    expect(changedKeys(a, b)).toEqual(['zebra', 'apple', 'mango'])
  })

  it('reports a key only the right operand has', () => {
    expect(changedKeys({ a: 1 }, { a: 1, b: 2 })).toEqual(['b'])
  })

  it('reports a key only the left operand has', () => {
    expect(changedKeys({ a: 1, b: 2 }, { a: 1 })).toEqual(['b'])
  })

  it('honours the ignore list', () => {
    expect(changedKeys({ name: 'x', topk: 1 }, { name: 'y', topk: 2 }, ['name']))
      .toEqual(['topk'])
  })

  it('compares arrays of objects by value, not by reference', () => {
    const features = [{ name: 'MOM', expression: '$close/Ref($close,20)-1' }]
    // Same content, different identity: this is the case `===` gets wrong, and
    // it is the common one — every render rebuilds the array.
    const copy = [{ name: 'MOM', expression: '$close/Ref($close,20)-1' }]
    expect(changedKeys({ features }, { features: copy })).toEqual([])

    const edited = [{ name: 'MOM', expression: '$close/Ref($close,10)-1' }]
    expect(changedKeys({ features }, { features: edited })).toEqual(['features'])
  })

  it('treats null and a missing key as different from a value', () => {
    expect(changedKeys({ limit_threshold: null }, { limit_threshold: 0.1 }))
      .toEqual(['limit_threshold'])
    expect(changedKeys({ limit_threshold: null }, { limit_threshold: null }))
      .toEqual([])
  })

  it('is empty for identical objects', () => {
    const spec = { model: 'lightgbm', topk: 50, features: null }
    expect(changedKeys(spec, { ...spec })).toEqual([])
  })
})

describe('showValue', () => {
  it('prints null and undefined identically', () => {
    expect(showValue(null)).toBe('—')
    expect(showValue(undefined)).toBe('—')
  })

  it('summarises an array by length rather than serialising it', () => {
    expect(showValue([{ name: 'a' }])).toBe('1 column')
    expect(showValue([{ name: 'a' }, { name: 'b' }])).toBe('2 columns')
    expect(showValue([])).toBe('—')
  })

  it('prints scalars as themselves', () => {
    expect(showValue('lightgbm')).toBe('lightgbm')
    expect(showValue(50)).toBe('50')
    expect(showValue(0)).toBe('0')
    expect(showValue(0.0005)).toBe('0.0005')
    expect(showValue(false)).toBe('false')
  })
})
