import { describe, expect, it } from 'vitest'

import type { VibeAlpha } from './api'
import {
  deriveFacets,
  filterAlphas,
  normalizeAlpha,
  normalizeMojibake,
  sortAlphas,
} from './alphaZoo'

// Minimal factory — all fields required by VibeAlpha, easy to override.
function alpha(over: Partial<VibeAlpha>): VibeAlpha {
  return {
    id: 'test_alpha',
    zoo: 'academic',
    nickname: 'Test Alpha',
    theme: ['momentum'],
    formula_latex: '\\mathrm{close}_{t-1}/\\mathrm{close}_{t-20} - 1',
    columns_required: ['$close'],
    extras_required: [],
    requires_sector: false,
    universe: ['equity_us'],
    frequency: ['daily'],
    decay_horizon: 5,
    min_warmup_bars: 20,
    notes: 'A test alpha factor.',
    ...over,
  }
}

// ── normalizeMojibake ──────────────────────────────────────────────────────

describe('normalizeMojibake', () => {
  it('converts em-dash mojibake (â€”) to em-dash', () => {
    // â€" (U+00E2 U+20AC U+201D) is the Windows-1252 misread of U+2014.
    expect(normalizeMojibake('longâ€”run')).toBe('long—run')
  })

  it('converts en-dash mojibake (â€“) to en-dash', () => {
    // â€" (U+00E2 U+20AC U+201C) is the Windows-1252 misread of U+2013.
    expect(normalizeMojibake('2020â€“2024')).toBe('2020–2024')
  })

  it("converts right-single-quote mojibake (â€™) to ’", () => {
    // â€™ (U+00E2 U+20AC U+2122) is the Windows-1252 misread of U+2019.
    expect(normalizeMojibake('Frazziniâ€™s')).toBe('Frazzini’s')
  })

  it('leaves clean ASCII strings untouched', () => {
    const clean = 'betting-against-beta'
    expect(normalizeMojibake(clean)).toBe(clean)
  })

  it('leaves clean Unicode strings untouched', () => {
    expect(normalizeMojibake('cross–sectional')).toBe('cross–sectional')
  })

  it('handles multiple artefacts in one string', () => {
    // em-dash + en-dash + right single quote, all in sequence
    const raw = 'Aâ€”Bâ€“Câ€™s'
    expect(normalizeMojibake(raw)).toBe('A—B–C’s')
  })

  it('handles an empty string', () => {
    expect(normalizeMojibake('')).toBe('')
  })
})

// ── normalizeAlpha ─────────────────────────────────────────────────────────

describe('normalizeAlpha', () => {
  it('normalizes nickname and notes', () => {
    const raw = alpha({
      nickname: 'Frazziniâ€™s alpha',
      notes: 'longâ€”run factor (2020â€“2024)',
    })
    const result = normalizeAlpha(raw)
    expect(result.nickname).toBe('Frazzini’s alpha')
    expect(result.notes).toBe('long—run factor (2020–2024)')
  })

  it('leaves all other fields unchanged', () => {
    const raw = alpha({ id: 'academic_bab', zoo: 'academic' })
    const result = normalizeAlpha(raw)
    expect(result.id).toBe(raw.id)
    expect(result.zoo).toBe(raw.zoo)
    expect(result.theme).toBe(raw.theme)
    expect(result.columns_required).toBe(raw.columns_required)
    expect(result.decay_horizon).toBe(raw.decay_horizon)
  })

  it('is idempotent — a second pass changes nothing', () => {
    const raw = alpha({ nickname: 'Aâ€”B' })
    const once = normalizeAlpha(raw)
    const twice = normalizeAlpha(once)
    expect(twice.nickname).toBe(once.nickname)
  })
})

// ── deriveFacets ───────────────────────────────────────────────────────────

describe('deriveFacets', () => {
  const items = [
    alpha({ id: 'a', zoo: 'academic', theme: ['momentum', 'volatility'], universe: ['equity_us'] }),
    alpha({ id: 'b', zoo: 'academic', theme: ['momentum'], universe: ['equity_us', 'equity_cn'] }),
    alpha({ id: 'c', zoo: 'practitioner', theme: ['value'], universe: ['equity_cn'] }),
  ]

  it('counts each zoo correctly', () => {
    const { zoos } = deriveFacets(items)
    const byValue = Object.fromEntries(zoos.map((z) => [z.value, z.count]))
    expect(byValue['academic']).toBe(2)
    expect(byValue['practitioner']).toBe(1)
  })

  it('counts multi-valued themes across all items', () => {
    const { themes } = deriveFacets(items)
    const byValue = Object.fromEntries(themes.map((t) => [t.value, t.count]))
    expect(byValue['momentum']).toBe(2)
    expect(byValue['volatility']).toBe(1)
    expect(byValue['value']).toBe(1)
  })

  it('counts multi-valued universes across all items', () => {
    const { universes } = deriveFacets(items)
    const byValue = Object.fromEntries(universes.map((u) => [u.value, u.count]))
    expect(byValue['equity_us']).toBe(2)
    expect(byValue['equity_cn']).toBe(2)
  })

  it('sorts by count descending, then value ascending on ties', () => {
    const { themes } = deriveFacets(items)
    // momentum (2) before value (1) and volatility (1)
    expect(themes[0].value).toBe('momentum')
    // value and volatility tie at 1 — alphabetical order decides
    expect(themes[1].value).toBe('value')
    expect(themes[2].value).toBe('volatility')
  })

  it('returns empty facets for an empty item list', () => {
    const facets = deriveFacets([])
    expect(facets.zoos).toEqual([])
    expect(facets.themes).toEqual([])
    expect(facets.universes).toEqual([])
  })

  it('a single-universe item contributes exactly one count', () => {
    const { universes } = deriveFacets([alpha({ id: 'solo', universe: ['equity_hk'] })])
    expect(universes).toEqual([{ value: 'equity_hk', count: 1 }])
  })
})

// ── filterAlphas ───────────────────────────────────────────────────────────

describe('filterAlphas', () => {
  const items = [
    alpha({
      id: 'academic_bab', zoo: 'academic', nickname: 'Frazzini betting-against-beta',
      theme: ['volatility'], universe: ['equity_us'],
      notes: 'BAB factor measures market beta exposure.',
    }),
    alpha({
      id: 'practitioner_mom', zoo: 'practitioner', nickname: 'Cross-sectional momentum',
      theme: ['momentum'], universe: ['equity_us', 'equity_cn'],
      notes: 'Price momentum signal.',
    }),
    alpha({
      id: 'academic_val', zoo: 'academic', nickname: 'Book-to-market value',
      theme: ['value'], universe: ['equity_cn'],
      notes: 'Classic value factor.',
    }),
  ]

  const noFilter = { search: '', zoo: null, theme: null, universe: null }

  it('returns all items when no filters are active', () => {
    expect(filterAlphas(items, noFilter)).toHaveLength(3)
  })

  it('filters by zoo', () => {
    const result = filterAlphas(items, { ...noFilter, zoo: 'academic' })
    expect(result.map((i) => i.id)).toEqual(['academic_bab', 'academic_val'])
  })

  it('filters by theme (all-of semantics for multi-theme items)', () => {
    const result = filterAlphas(items, { ...noFilter, theme: 'momentum' })
    expect(result.map((i) => i.id)).toEqual(['practitioner_mom'])
  })

  it('filters by universe (item must include the selected universe)', () => {
    const result = filterAlphas(items, { ...noFilter, universe: 'equity_cn' })
    expect(result.map((i) => i.id)).toEqual(['practitioner_mom', 'academic_val'])
  })

  it('matches search text in id', () => {
    const result = filterAlphas(items, { ...noFilter, search: 'bab' })
    expect(result.map((i) => i.id)).toEqual(['academic_bab'])
  })

  it('matches search text in nickname', () => {
    const result = filterAlphas(items, { ...noFilter, search: 'momentum' })
    expect(result.map((i) => i.id)).toEqual(['practitioner_mom'])
  })

  it('matches search text in notes', () => {
    const result = filterAlphas(items, { ...noFilter, search: 'beta exposure' })
    expect(result.map((i) => i.id)).toEqual(['academic_bab'])
  })

  it('search is case-insensitive', () => {
    const result = filterAlphas(items, { ...noFilter, search: 'MOMENTUM' })
    expect(result.map((i) => i.id)).toEqual(['practitioner_mom'])
  })

  it('search trims leading/trailing whitespace before matching', () => {
    const result = filterAlphas(items, { ...noFilter, search: '  bab  ' })
    expect(result.map((i) => i.id)).toEqual(['academic_bab'])
  })

  it('combines zoo and theme filters (AND logic)', () => {
    const result = filterAlphas(items, { ...noFilter, zoo: 'academic', theme: 'volatility' })
    expect(result.map((i) => i.id)).toEqual(['academic_bab'])
  })

  it('a zoo + theme combination that matches nothing returns an empty array', () => {
    const result = filterAlphas(items, { ...noFilter, zoo: 'practitioner', theme: 'value' })
    expect(result).toHaveLength(0)
  })

  it('returns empty array when search text matches nothing', () => {
    const result = filterAlphas(items, { ...noFilter, search: 'nonexistent_xyz_123' })
    expect(result).toHaveLength(0)
  })

  it('returns empty array when input list is empty', () => {
    const result = filterAlphas([], { ...noFilter, search: 'momentum' })
    expect(result).toHaveLength(0)
  })
})

// ── sortAlphas ─────────────────────────────────────────────────────────────

describe('sortAlphas', () => {
  const items = [
    alpha({ id: 'c_val', nickname: 'C Value', zoo: 'practitioner', decay_horizon: 10 }),
    alpha({ id: 'a_mom', nickname: 'A Momentum', zoo: 'academic', decay_horizon: null }),
    alpha({ id: 'b_bab', nickname: 'B Beta', zoo: 'academic', decay_horizon: 2 }),
  ]

  it('sorts by nickname ascending', () => {
    const sorted = sortAlphas(items, 'nickname')
    expect(sorted.map((i) => i.nickname)).toEqual(['A Momentum', 'B Beta', 'C Value'])
  })

  it('sorts by id ascending', () => {
    const sorted = sortAlphas(items, 'id')
    expect(sorted.map((i) => i.id)).toEqual(['a_mom', 'b_bab', 'c_val'])
  })

  it('sorts by zoo, tiebreaking on nickname', () => {
    const sorted = sortAlphas(items, 'zoo')
    // academic (A Momentum, B Beta) before practitioner (C Value)
    expect(sorted[0].nickname).toBe('A Momentum')
    expect(sorted[1].nickname).toBe('B Beta')
    expect(sorted[2].nickname).toBe('C Value')
  })

  it('sorts by decay_horizon ascending, nulls last', () => {
    const sorted = sortAlphas(items, 'decay_horizon')
    // 2 → 10 → null(Infinity)
    expect(sorted.map((i) => i.decay_horizon)).toEqual([2, 10, null])
  })

  it('does not mutate the input array', () => {
    const original = [...items]
    sortAlphas(items, 'nickname')
    expect(items.map((i) => i.id)).toEqual(original.map((i) => i.id))
  })

  it('handles a single-item list', () => {
    const single = [alpha({ id: 'solo', nickname: 'Solo' })]
    expect(sortAlphas(single, 'nickname')).toEqual(single)
  })
})
