import { describe, expect, it } from 'vitest'

import {
  DATABASE_TABS, familyLabel, freshness, parseUid, sourceBreakdown, sourceLabel,
  summaryLine, tabCount, tabForLegacyRoute, tabFromParam,
} from './catalog'
import type {
  CatalogCollection, CatalogHarvestRecord, CatalogSummary,
} from '@/lib/api'

const record = (over: Partial<CatalogHarvestRecord> = {}): CatalogHarvestRecord => ({
  harvester: 'curated', source: 'curated', started_at: '2026-08-13T06:00:00+00:00',
  finished_at: '2026-08-13T06:00:01+00:00', count: 121, error: null, ...over,
})

const summary = (over: Partial<CatalogSummary> = {}): CatalogSummary => ({
  total: 919, links: 28, indexed: true,
  collections: [], harvests: [], harvesters: [], degraded: [],
  kinds: [], sources: [], running_job: null, ...over,
})

describe('parseUid', () => {
  it('splits on the first two colons only', () => {
    expect(parseUid('alpha:qlib:alpha158.KMID')).toEqual({
      kind: 'alpha', source: 'qlib', localId: 'alpha158.KMID',
    })
  })

  it('keeps colons inside the local id', () => {
    expect(parseUid('document:rag:ns:abc')?.localId).toBe('ns:abc')
  })

  it.each(['', 'alpha', 'alpha:qlib', ':qlib:x', 'alpha::x', 'alpha:qlib:'])(
    'refuses %o rather than returning a half-parsed uid', (uid) => {
      expect(parseUid(uid)).toBeNull()
    },
  )
})

describe('tabFromParam', () => {
  it('accepts a known tab', () => {
    expect(tabFromParam('alphas')).toBe('alphas')
  })

  it.each([null, undefined, '', 'nonsense', 'Alphas'])(
    'falls back to overview for %o rather than throwing', (raw) => {
      expect(tabFromParam(raw)).toBe('overview')
    },
  )
})

describe('tabForLegacyRoute', () => {
  it.each([
    ['/lab/alpha-zoo', 'alphas'],
    ['/indicators', 'indicators'],
    ['/documents', 'documents'],
    ['/documents/abc', 'documents'],
    ['/markets', 'instruments'],
    ['/macro', 'macro'],
    ['/runs', 'backtests'],
    ['/explorer', 'graph'],
  ])('%s lands on the tab that took over its job', (path, tab) => {
    expect(tabForLegacyRoute(path)).toBe(tab)
  })

  it('leaves a route the Database never absorbed alone', () => {
    expect(tabForLegacyRoute('/lab/builder')).toBeNull()
    expect(tabForLegacyRoute('/book')).toBeNull()
  })

  it('every legacy route maps to a tab that exists', () => {
    const known = new Set(DATABASE_TABS.map((t) => t.tab))
    for (const path of ['/lab/alpha-zoo', '/indicators', '/runs', '/documents',
      '/corpus', '/markets', '/macro', '/explorer', '/factors', '/data',
      '/lab/databank']) {
      expect(known.has(tabForLegacyRoute(path)!)).toBe(true)
    }
  })
})

describe('freshness', () => {
  it('separates never-run from run-clean', () => {
    expect(freshness('curated', []).state).toBe('never')
    expect(freshness('curated', [record()]).state).toBe('ok')
  })

  it('calls a failed run degraded, not fresh', () => {
    // The case a bare "last updated" would blur: these rows are the *previous*
    // harvest's, and reporting them as current is the lie this prevents.
    const result = freshness('zoo', [record({ harvester: 'zoo', error: 'sidecar is down' })])
    expect(result.state).toBe('degraded')
    expect(result.detail).toContain('previous harvest')
    expect(result.detail).toContain('sidecar is down')
  })
})

describe('tabCount', () => {
  const collections: CatalogCollection[] = [
    { kind: 'alpha', count: 639, sources: { qlib: 518, curated: 121 } },
    { kind: 'operator', count: 50, sources: { qlib: 50 } },
    { kind: 'indicator', count: 184, sources: { qlib: 184 } },
  ]

  it('sums every kind the tab browses', () => {
    const indicators = DATABASE_TABS.find((t) => t.tab === 'indicators')!
    // 184 indicators + 50 operators: the grammar is browsed with the vocabulary.
    expect(tabCount(indicators, collections)).toBe(234)
  })

  it('counts only what the tab actually shows', () => {
    // A label promising 689 over a table showing 639 is a miscount. Operators
    // are the grammar an indicator is written in, and they are browsed there.
    const alphas = DATABASE_TABS.find((t) => t.tab === 'alphas')!
    expect(alphas.kinds).toEqual(['alpha'])
    expect(tabCount(alphas, collections)).toBe(639)
  })

  it('is zero for a tab with no catalog kinds of its own', () => {
    const documents = DATABASE_TABS.find((t) => t.tab === 'documents')!
    expect(tabCount(documents, collections)).toBe(0)
  })

  it('is zero for a kind that has not been harvested', () => {
    const backtests = DATABASE_TABS.find((t) => t.tab === 'backtests')!
    expect(tabCount(backtests, collections)).toBe(0)
  })
})

describe('sourceBreakdown', () => {
  it('is biggest first', () => {
    expect(sourceBreakdown({
      kind: 'alpha', count: 639, sources: { curated: 121, qlib: 518 },
    })).toEqual([
      { value: 'qlib', count: 518 },
      { value: 'curated', count: 121 },
    ])
  })
})

describe('familyLabel', () => {
  it('prefers the label the harvester carried', () => {
    expect(familyLabel({ family: 'anomaly', payload: { family_label: 'Academic anomalies' } }))
      .toBe('Academic anomalies')
  })

  it('falls back to the raw key rather than inventing a label', () => {
    expect(familyLabel({ family: 'alpha360', payload: {} })).toBe('alpha360')
    expect(familyLabel({ family: null, payload: {} })).toBe('—')
  })
})

describe('sourceLabel', () => {
  it('uses the upstream name', () => {
    // The sidecar, not one of its collections: the same badge labels a zoo
    // alpha on the Database and a swarm team on the roster.
    expect(sourceLabel('vibe')).toBe('Vibe')
    expect(sourceLabel('rag')).toBe('RAG')
  })

  it('passes an unknown source through rather than blanking it', () => {
    expect(sourceLabel('somethingnew')).toBe('somethingnew')
  })
})

describe('summaryLine', () => {
  it('says press reindex when nothing is indexed', () => {
    expect(summaryLine(summary({ indexed: false, total: 0 }))).toContain('Reindex')
  })

  it('reports the totals when every source is clean', () => {
    const line = summaryLine(summary({
      collections: [{ kind: 'alpha', count: 639, sources: {} }],
    }))
    expect(line).toContain('919')
    expect(line).toContain('28 links')
    expect(line).not.toContain('failed')
  })

  it('names the failed sources rather than reporting only the total', () => {
    // "919 indexed" beside a dead sidecar reads as complete. It is not.
    const line = summaryLine(summary({ degraded: ['vibe_zoo'] }))
    expect(line).toContain('1 source failed')
    expect(line).toContain('vibe_zoo')
    expect(line).toContain('older rows')
  })

  it('pluralises when more than one failed', () => {
    expect(summaryLine(summary({ degraded: ['vibe_zoo', 'instruments'] })))
      .toContain('2 sources failed')
  })
})
