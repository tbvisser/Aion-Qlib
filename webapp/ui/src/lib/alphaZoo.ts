/**
 * Alpha Zoo — pure filtering, faceting, sorting, and mojibake repair.
 *
 * No React, no DOM — safe for vitest/node. The page (AlphaZooPage) feeds
 * filtered items from these functions; tests exercise the rules directly.
 *
 * Mojibake context: the upstream data was stored as UTF-8 but decoded as
 * Windows-1252 somewhere in the pipeline. The three most common artefacts
 * are the em-dash, en-dash, and right-single-quote — all sharing the
 * E2 80 xx UTF-8 prefix mapped to the sequence â€{quote} in Windows-1252.
 */
import type { VibeAlpha } from './api'

// ── Mojibake normalization ─────────────────────────────────────────────────

/**
 * Repair the three most common Windows-1252 misread artefacts found in the
 * upstream alpha catalog. Designed to be called on free-text fields only
 * (nickname, notes) — not on identifiers or enum values.
 */
export function normalizeMojibake(s: string): string {
  return s
    // U+2014 em-dash: UTF-8 E2 80 94 misread as â (U+00E2) + € (U+20AC) + " (U+201D)
    .replace(/â€”/g, '—')
    // U+2013 en-dash: UTF-8 E2 80 93 misread as â (U+00E2) + € (U+20AC) + " (U+201C)
    .replace(/â€“/g, '–')
    // U+2019 right single quote: UTF-8 E2 80 99 misread as â (U+00E2) + € (U+20AC) + ™ (U+2122)
    .replace(/â€™/g, '’')
}

/** Normalize the free-text fields of a single alpha; other fields are passed through unchanged. */
export function normalizeAlpha(alpha: VibeAlpha): VibeAlpha {
  return {
    ...alpha,
    nickname: normalizeMojibake(alpha.nickname),
    notes: normalizeMojibake(alpha.notes),
  }
}

// ── Facets ─────────────────────────────────────────────────────────────────

export interface AlphaFacetOption {
  value: string
  count: number
}

export interface AlphaFacets {
  zoos: AlphaFacetOption[]
  themes: AlphaFacetOption[]
  universes: AlphaFacetOption[]
}

/**
 * Derive available filter values with occurrence counts from a flat item list.
 * Results are sorted by count descending, then value ascending — so the most
 * represented option appears first in every facet dropdown.
 */
export function deriveFacets(items: VibeAlpha[]): AlphaFacets {
  const zooCounts = new Map<string, number>()
  const themeCounts = new Map<string, number>()
  const universeCounts = new Map<string, number>()

  for (const item of items) {
    zooCounts.set(item.zoo, (zooCounts.get(item.zoo) ?? 0) + 1)
    for (const t of item.theme) {
      themeCounts.set(t, (themeCounts.get(t) ?? 0) + 1)
    }
    for (const u of item.universe) {
      universeCounts.set(u, (universeCounts.get(u) ?? 0) + 1)
    }
  }

  const toSorted = (m: Map<string, number>): AlphaFacetOption[] =>
    [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))

  return {
    zoos: toSorted(zooCounts),
    themes: toSorted(themeCounts),
    universes: toSorted(universeCounts),
  }
}

// ── Filtering ──────────────────────────────────────────────────────────────

export interface AlphaFilters {
  /** Free-text substring matched against id, nickname, and notes (case-insensitive). */
  search: string
  /** Exact match against the zoo field; null means no zoo filter. */
  zoo: string | null
  /** Item must include this value in its theme array; null means no theme filter. */
  theme: string | null
  /** Item must include this value in its universe array; null means no universe filter. */
  universe: string | null
}

/**
 * Filter a list of alphas against the active filter state. All non-null
 * facet selections AND the search text must match (AND semantics).
 */
export function filterAlphas(items: VibeAlpha[], filters: AlphaFilters): VibeAlpha[] {
  const { search, zoo, theme, universe } = filters
  const needle = search.trim().toLowerCase()

  return items.filter((item) => {
    if (zoo !== null && item.zoo !== zoo) return false
    if (theme !== null && !item.theme.includes(theme)) return false
    if (universe !== null && !item.universe.includes(universe)) return false
    if (needle) {
      const haystack = `${item.id} ${item.nickname} ${item.notes}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

// ── Sorting ────────────────────────────────────────────────────────────────

export type AlphaSort = 'nickname' | 'id' | 'zoo' | 'decay_horizon'

/**
 * Return a new sorted array without mutating the input.
 * Ties in zoo and decay_horizon fall back to nickname order.
 */
export function sortAlphas(items: VibeAlpha[], sort: AlphaSort): VibeAlpha[] {
  return [...items].sort((a, b): number => {
    if (sort === 'nickname') return a.nickname.localeCompare(b.nickname)
    if (sort === 'id') return a.id.localeCompare(b.id)
    if (sort === 'zoo') return a.zoo.localeCompare(b.zoo) || a.nickname.localeCompare(b.nickname)
    // decay_horizon: nulls sort last (treated as Infinity)
    const ad = a.decay_horizon ?? Infinity
    const bd = b.decay_horizon ?? Infinity
    return ad - bd || a.nickname.localeCompare(b.nickname)
  })
}
