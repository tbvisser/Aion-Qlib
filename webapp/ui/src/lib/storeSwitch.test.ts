import { describe, expect, it } from 'vitest'

import { DEFAULT_STRATEGY, type DataStore } from '@/lib/api'
import { applyStore, selectableUniverses } from './storeSwitch'

const store = (over: Partial<DataStore> & Pick<DataStore, 'key'>): DataStore => ({
  label: over.key,
  provider_uri: `/data/${over.key}`,
  region: 'us',
  note: '',
  exists: true,
  calendar_days: 4102,
  universes: ['top500', 'benchmarks'],
  calendar_start: '2010-01-04',
  calendar_end: '2026-08-07',
  benchmarks: ['SPY'],
  mounted: true,
  ...over,
})

const US = store({ key: 'us' })
const CRYPTO = store({
  key: 'crypto_365',
  universes: ['crypto_majors', 'benchmarks'],
  benchmarks: [],
  calendar_end: '2026-08-11',
})
const STORES = [US, CRYPTO]

describe('selectableUniverses', () => {
  it('drops the benchmarks instruments file, which is not a tradable universe', () => {
    expect(selectableUniverses(US)).toEqual(['top500'])
  })

  it('is empty for an absent store', () => {
    expect(selectableUniverses(undefined)).toEqual([])
  })
})

describe('applyStore', () => {
  it('is a no-op for a store key it does not know', () => {
    expect(applyStore(DEFAULT_STRATEGY, STORES, 'nope')).toBe(DEFAULT_STRATEGY)
  })

  it('keeps a universe the new store also lists', () => {
    const both = [US, store({ key: 'crypto_365', universes: ['top500', 'crypto_majors'] })]
    expect(applyStore(DEFAULT_STRATEGY, both, 'crypto_365').universe).toBe('top500')
  })

  it('falls back to the new store first universe when the current one is gone', () => {
    expect(applyStore(DEFAULT_STRATEGY, STORES, 'crypto_365').universe).toBe('crypto_majors')
  })

  it('leaves the universe blank rather than stale when the store lists none', () => {
    const bare = [store({ key: 'crypto_365', universes: ['benchmarks'] })]
    expect(applyStore(DEFAULT_STRATEGY, bare, 'crypto_365').universe).toBe('')
  })

  it('reassigns the benchmark only when the new store offers one that fits', () => {
    const nasdaq = [store({ key: 'crypto_365', benchmarks: ['QQQ', 'IWM'] })]
    expect(applyStore(DEFAULT_STRATEGY, nasdaq, 'crypto_365').benchmark).toBe('QQQ')
  })

  it('keeps a benchmark the new store already lists', () => {
    const also = [store({ key: 'crypto_365', benchmarks: ['QQQ', 'SPY'] })]
    expect(applyStore(DEFAULT_STRATEGY, also, 'crypto_365').benchmark).toBe('SPY')
  })

  /**
   * A store shipping no benchmarks file is not a store saying the current one
   * is wrong. Blanking it here would overwrite a deliberate choice — a crypto
   * template arrives carrying BTC-USD — and the backend already reports a
   * benchmark it cannot find.
   */
  it('leaves the benchmark alone when the new store ships no list', () => {
    expect(applyStore(DEFAULT_STRATEGY, STORES, 'crypto_365').benchmark).toBe('SPY')
  })

  it('takes the new store last safely-backtestable date', () => {
    expect(applyStore(DEFAULT_STRATEGY, STORES, 'crypto_365').test_end).toBe('2026-08-11')
  })

  it('keeps the previous end date when the new store has no calendar', () => {
    const unbuilt = [store({ key: 'crypto_365', exists: false, calendar_end: null })]
    expect(applyStore(DEFAULT_STRATEGY, unbuilt, 'crypto_365').test_end)
      .toBe(DEFAULT_STRATEGY.test_end)
  })

  it('touches nothing else', () => {
    const next = applyStore(DEFAULT_STRATEGY, STORES, 'crypto_365')
    const untouched = { ...next, data_store: 'us', universe: 'top500', test_end: DEFAULT_STRATEGY.test_end }
    expect(untouched).toEqual(DEFAULT_STRATEGY)
  })

  /**
   * Moving only `test_end` could leave `test_end < test_start`, or a train
   * window entirely before the store's first bar — an invalid window the user
   * only heard about from the server, one debounced round-trip later.
   */
  it('clamps the whole window into the new store calendar', () => {
    const late = [store({
      key: 'crypto_365',
      calendar_start: '2020-06-01',
      calendar_end: '2021-12-31',
    })]
    const next = applyStore(DEFAULT_STRATEGY, late, 'crypto_365')
    // DEFAULT trains 2010–2019, entirely before this store begins.
    expect(next.train_start).toBe('2020-06-01')
    expect(next.train_end).toBe('2020-06-01')
    expect(next.valid_start).toBe('2020-06-01')
    expect(next.valid_end).toBe('2021-12-31')
    expect(next.test_start).toBe('2021-12-31')
    expect(next.test_end).toBe('2021-12-31')
    // No inversions anywhere.
    expect(next.test_start <= next.test_end).toBe(true)
    expect(next.train_start <= next.train_end).toBe(true)
  })

  it('leaves dates already inside the calendar untouched', () => {
    const next = applyStore(DEFAULT_STRATEGY, STORES, 'crypto_365')
    expect(next.train_start).toBe(DEFAULT_STRATEGY.train_start)
    expect(next.valid_end).toBe(DEFAULT_STRATEGY.valid_end)
  })
})
