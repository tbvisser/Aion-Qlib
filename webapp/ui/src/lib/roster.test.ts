import { describe, expect, it } from 'vitest'

import {
  ROSTER_TABS, providerState, rosterBreakdown, rosterSummaryLine, rosterTabCount,
  rosterTabFromParam, rosterTabSpec,
} from './roster'
import type { CatalogCollection, RegistryProvider, RegistrySummary } from '@/lib/api'

const provider = (over: Partial<RegistryProvider> = {}): RegistryProvider => ({
  name: 'vibe_skills', label: 'Vibe skill library', kind: 'skill', source: 'vibe',
  remote: true, count: 89, fetched_at: '2026-08-13T07:00:00+00:00',
  error: null, stale: false, ...over,
})

const summary = (over: Partial<RegistrySummary> = {}): RegistrySummary => ({
  total: 220,
  collections: [
    { kind: 'agent', count: 11, sources: { aion: 2, vibe: 5, rag: 4 } },
    { kind: 'skill', count: 92, sources: { vibe: 89, aion: 3 } },
    { kind: 'swarm', count: 30, sources: { vibe: 30 } },
    { kind: 'tool', count: 87, sources: { rag: 44, vibe: 34, aion: 9 } },
  ],
  providers: [provider()],
  degraded: [], ttl_seconds: 120, kinds: [], sources: [],
  ...over,
})

describe('rosterTabFromParam', () => {
  it('accepts a known tab', () => {
    expect(rosterTabFromParam('swarms')).toBe('swarms')
    expect(rosterTabFromParam('authored')).toBe('authored')
  })

  it.each([null, undefined, '', 'nonsense', 'Swarms'])(
    'falls back to overview for %o rather than throwing', (raw) => {
      expect(rosterTabFromParam(raw)).toBe('overview')
    },
  )
})

describe('ROSTER_TABS', () => {
  it('is the six the page renders, in order', () => {
    expect(ROSTER_TABS.map((t) => t.tab)).toEqual([
      'overview', 'swarms', 'agents', 'skills', 'tools', 'authored',
    ])
  })

  it('gives every browsing tab a placeholder, because "expression" means nothing here', () => {
    for (const spec of ROSTER_TABS.filter((t) => t.kinds.length)) {
      expect(spec.placeholder, `${spec.tab} has no placeholder`).toBeTruthy()
    }
  })

  it('claims no catalog kind for the tabs that browse none', () => {
    // Overview is a dashboard; Your Skills is per-user Supabase rows the
    // server-side providers cannot see. Neither may report a count.
    expect(rosterTabSpec('overview').kinds).toEqual([])
    expect(rosterTabSpec('authored').kinds).toEqual([])
  })
})

describe('rosterTabCount', () => {
  const collections = summary().collections as CatalogCollection[]

  it.each([
    ['swarms', 30],
    ['agents', 11],
    ['skills', 92],
    ['tools', 87],
  ] as const)('%s counts %i', (tab, expected) => {
    expect(rosterTabCount(rosterTabSpec(tab), collections)).toBe(expected)
  })

  it('is zero for a tab with no kinds of its own', () => {
    expect(rosterTabCount(rosterTabSpec('authored'), collections)).toBe(0)
  })

  it('sums to the summary total', () => {
    const total = ROSTER_TABS.reduce((sum, spec) => sum + rosterTabCount(spec, collections), 0)
    expect(total).toBe(220)
  })
})

describe('providerState', () => {
  it('reports a clean fetch as ok', () => {
    const state = providerState(provider())
    expect(state.state).toBe('ok')
    expect(state.detail).toContain('89')
  })

  it('separates stale from down — the distinction a single "error" would lose', () => {
    // Stale: the fetch failed but earlier rows are still on screen.
    const stale = providerState(provider({ error: 'ConnectError: refused', stale: true }))
    expect(stale.state).toBe('stale')
    expect(stale.detail).toContain('last successful fetch')
    expect(stale.detail).toContain('89')

    // Down: failed with nothing cached, so the collection really is empty.
    const down = providerState(provider({ error: 'ConnectError: refused', stale: false, count: 0 }))
    expect(down.state).toBe('down')
    expect(down.detail).toContain('nothing cached')
  })

  it('carries the error text through, so the cause is on screen', () => {
    expect(providerState(provider({ error: 'ConnectError: refused', stale: true })).detail)
      .toContain('ConnectError: refused')
  })
})

describe('rosterBreakdown', () => {
  it('is biggest first', () => {
    expect(rosterBreakdown({ kind: 'tool', count: 87, sources: { aion: 9, rag: 44, vibe: 34 } }))
      .toEqual([
        { value: 'rag', count: 44 },
        { value: 'vibe', count: 34 },
        { value: 'aion', count: 9 },
      ])
  })
})

describe('rosterSummaryLine', () => {
  it('reports the totals and the backend count when everything is reachable', () => {
    const line = rosterSummaryLine(summary({
      providers: [provider(), provider({ name: 'rag_tools', source: 'rag' })],
    }))
    expect(line).toContain('220')
    expect(line).toContain('4 collections')
    expect(line).toContain('2 backends')
    expect(line).not.toContain('unreachable')
  })

  it('names the unreachable providers rather than reporting only a total', () => {
    // "220 across 4 collections" beside a dead sidecar reads as complete.
    const line = rosterSummaryLine(summary({
      degraded: ['vibe_skills'],
      providers: [provider({ error: 'ConnectError', stale: true })],
    }))
    expect(line).toContain('1 unreachable')
    expect(line).toContain('Vibe skill library')
    expect(line).toContain('earlier fetch')
  })

  it('says outright when an unreachable provider has nothing cached', () => {
    const line = rosterSummaryLine(summary({
      degraded: ['vibe_skills'],
      providers: [provider({ error: 'ConnectError', stale: false, count: 0 })],
    }))
    expect(line).toContain('nothing cached')
    expect(line).toContain('missing entirely')
  })

  it('pluralises across several unreachable providers', () => {
    const line = rosterSummaryLine(summary({
      degraded: ['vibe_skills', 'vibe_swarms'],
      providers: [
        provider({ error: 'ConnectError', stale: false, count: 0 }),
        provider({ name: 'vibe_swarms', label: 'Vibe swarm teams', error: 'ConnectError', stale: false, count: 0 }),
      ],
    }))
    expect(line).toContain('2 unreachable')
    expect(line).toContain('2 of them have nothing cached')
  })
})
