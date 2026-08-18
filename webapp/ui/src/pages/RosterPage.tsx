import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { PageHeader } from '@/components/layout/PageHeader'
import { Notice } from '@/components/ui/notice'
import {
  NameCell, SourceBadge, type Column,
} from '@/components/database/CatalogBrowser'
import { RosterOverview } from '@/components/roster/RosterOverview'
import { RosterDetail } from '@/components/roster/RosterDetail'
import { AgentConsolePanel } from '@/components/roster/AgentConsolePanel'
import { RosterCatalogDashboard } from '@/components/roster/RosterCatalogDashboard'
import { SkillsPage } from '@/features/rag/pages/SkillsPage'
import { useRegistryFacets, useRegistrySearch, useRegistrySummary } from '@/hooks/useRegistry'
import {
  ROSTER_TABS, rosterTabSpec, type RosterTab,
} from '@/lib/roster'
import { cn } from '@/lib/utils'
import type { RegistryEntity } from '@/lib/api'

/**
 * Agents & Skills — the Database's twin.
 *
 * Same shell, same search box, same facet rail, same table and detail rail,
 * because they are the same act: browse a collection of things the platform
 * knows about. What differs is underneath. The Database reads one SQLite index;
 * this federates four backends live — the Vibe sidecar's swarm teams, skills,
 * allowlisted MCP tools and playbooks; the vendored RAG backend's tools,
 * harness and sub-agents; this API's own chat profiles and tools; and file
 * skills sitting in the repo.
 *
 * **Aion in front, four repos behind.** Nothing here carries an upstream's
 * branding, stylesheet or embedded UI. Provenance is one badge per row, and the
 * single exception is the one that cannot be otherwise: the Vibe console sends
 * `frame-ancestors 'none'`, so it stays a status card with a link out.
 */
export function RosterPage() {
  const [params, setParams] = useSearchParams()
  const tab = rosterTabFromParam(params.get('tab'))
  const { summary, loading, error, refresh, refreshing } = useRegistrySummary()
  const [selected, setSelected] = useState<RegistryEntity | null>(null)

  const setTab = useCallback((next: RosterTab) => {
    setParams((prev) => {
      const updated = new URLSearchParams(prev)
      updated.set('tab', next)
      return updated
    }, { replace: true })
    setSelected(null)
  }, [setParams])

  const browsing = rosterTabSpec(tab).kinds.length > 0

  return (
    <>
      <PageHeader
        title="Agents & Skills"
        description="Every swarm team, agent, skill and tool this platform can reach — from the Vibe sidecar, the RAG backend, this API and the repo, in one searchable place."
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <TabNav active={tab} onChange={setTab} />

          <div className="flex min-h-0 flex-1 flex-col">
            {error && (
              <div className="px-6 pt-4">
                <Notice tone="destructive">{error}</Notice>
              </div>
            )}
            {loading && !summary && (
              <div className="px-6 pt-4 text-[12px] text-muted-foreground">
                Reaching the backends…
              </div>
            )}

            {tab === 'authored' ? (
              <SkillsPage />
            ) : (
              <div className="p-6">
                {summary && tab === 'overview' && (
                  <RosterOverview
                    summary={summary}
                    onRefresh={refresh}
                    refreshing={refreshing}
                    onOpenTab={setTab}
                  />
                )}

                {summary && tab === 'swarms' && (
                  <RosterCatalogDashboard
                    spec={rosterTabSpec('swarms')}
                    summary={summary}
                    columns={[
                      NAME,
                      SOURCE,
                      family('Preset', 'w-[12%]'),
                      {
                        key: 'agents', label: 'Agents', width: 'w-[10%]', numeric: true,
                        render: (e) => (
                          <span className="font-mono text-[11px] tabular-nums">
                            {String(e.payload.agent_count ?? '—')}
                          </span>
                        ),
                      },
                      detail('Takes', (e) => {
                        const variables = Array.isArray(e.payload.variables) ? e.payload.variables : []
                        return (
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {variables.map((v) => (v as { name?: string }).name).filter(Boolean).join(', ') || '—'}
                          </span>
                        )
                      }),
                    ]}
                    useData={useRegistrySearch}
                    useFacets={useRegistryFacets}
                    selected={selected?.uid}
                    onSelect={setSelected}
                    refreshing={refreshing}
                    onRefresh={refresh}
                    blurb={
                      <>
                        Multi-agent teams the sidecar can run: a fixed roster of role-specialised agents
                        over a task graph. The Investment Committee is a bull-side researcher, a bear-side
                        researcher, a risk officer and the PM who makes the call.
                      </>
                    }
                  />
                )}

                {summary && tab === 'agents' && (
                  <RosterCatalogDashboard
                    spec={rosterTabSpec('agents')}
                    summary={summary}
                    columns={[
                      NAME,
                      SOURCE,
                      family('Kind', 'w-[14%]'),
                      detail('Detail', (e) => {
                        const tools = Array.isArray(e.payload.tools) ? e.payload.tools.length : null
                        const schedule = e.payload.suggested_schedule
                        const phases = e.payload.phase_count
                        const text = schedule ? String(schedule)
                          : phases ? `${phases} phases`
                            : tools !== null ? `${tools} tools` : '—'
                        return (
                          <span className="truncate font-mono text-[11px] text-muted-foreground">{text}</span>
                        )
                      }),
                    ]}
                    useData={useRegistrySearch}
                    useFacets={useRegistryFacets}
                    selected={selected?.uid}
                    onSelect={setSelected}
                    refreshing={refreshing}
                    onRefresh={refresh}
                    blurb={
                      <>
                        Everything that runs on its own: this API's chat profiles, the sidecar's scheduled
                        playbooks, and the RAG backend's harness and sub-agents. A profile is a prompt plus
                        a tool list — and the tools it does <em>not</em> have are its safety model, not an
                        instruction.
                      </>
                    }
                    extra={<AgentConsolePanel />}
                  />
                )}

                {summary && tab === 'skills' && (
                  <RosterCatalogDashboard
                    spec={rosterTabSpec('skills')}
                    summary={summary}
                    columns={[
                      { ...NAME, width: 'w-[30%]' },
                      SOURCE,
                      family('Kind', 'w-[14%]'),
                      detail('Description', (e) => (
                        <span className="truncate text-[11px] text-muted-foreground">{e.summary ?? '—'}</span>
                      )),
                    ]}
                    useData={useRegistrySearch}
                    useFacets={useRegistryFacets}
                    selected={selected?.uid}
                    onSelect={setSelected}
                    refreshing={refreshing}
                    onRefresh={refresh}
                    blurb={
                      <>
                        Methodologies the assistant loads on demand rather than carrying in its prompt —
                        the sidecar's library plus the file-based ones in this repo. To write your own,
                        use the Your Skills tab.
                      </>
                    }
                  />
                )}

                {summary && tab === 'tools' && (
                  <RosterCatalogDashboard
                    spec={rosterTabSpec('tools')}
                    summary={summary}
                    columns={[
                      { ...NAME, width: 'w-[30%]' },
                      SOURCE,
                      family('Group', 'w-[14%]'),
                      {
                        key: 'params', label: 'Params', width: 'w-[9%]', numeric: true,
                        render: (e) => {
                          const schema = e.payload.input_schema as { properties?: object } | undefined
                          const count = schema?.properties ? Object.keys(schema.properties).length : 0
                          return count
                            ? <span className="font-mono text-[11px] tabular-nums">{count}</span>
                            : <span className="text-muted-foreground/50">—</span>
                        },
                      },
                      detail('Description', (e) => (
                        <span className="truncate text-[11px] text-muted-foreground">{e.summary ?? '—'}</span>
                      )),
                    ]}
                    useData={useRegistrySearch}
                    useFacets={useRegistryFacets}
                    selected={selected?.uid}
                    onSelect={setSelected}
                    refreshing={refreshing}
                    onRefresh={refresh}
                    blurb={
                      <>
                        Every callable the platform has, across three runtimes. The same tool can appear
                        twice with different sources — the RAG backend reaches the sidecar over MCP, so
                        it holds its own handle on tools the proxy also exposes directly.
                      </>
                    }
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {browsing && selected && (
          <RosterDetail uid={selected.uid} onClose={() => setSelected(null)} />
        )}
      </div>
    </>
  )
}

function TabNav({ active, onChange }: { active: RosterTab; onChange: (tab: RosterTab) => void }) {
  return (
    <div className="sticky top-0 z-20 border-b border-border/50 bg-background/80 px-6 py-2 backdrop-blur">
      <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border/50 p-0.5">
        {ROSTER_TABS.map((spec) => (
          <button
            key={spec.tab}
            type="button"
            onClick={() => onChange(spec.tab)}
            className={cn(
              'shrink-0 rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors',
              active === spec.tab
                ? 'bg-foreground/[0.07] text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {spec.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function rosterTabFromParam(raw: string | null | undefined): RosterTab {
  const TAB_KEYS = new Set(ROSTER_TABS.map((t) => t.tab))
  return raw && TAB_KEYS.has(raw as RosterTab) ? (raw as RosterTab) : 'overview'
}

// --- shared cells ---------------------------------------------------------

const NAME: Column<RegistryEntity> = {
  key: 'name', label: 'Name', width: 'w-[36%]',
  render: (e) => <NameCell entity={{ name: e.title || e.name, summary: e.summary }} />,
}

const SOURCE: Column<RegistryEntity> = {
  key: 'source', label: 'Source', width: 'w-[12%]',
  render: (e) => <SourceBadge source={e.source} />,
}

const family = (label: string, width: string): Column<RegistryEntity> => ({
  key: 'family', label, width,
  render: (e) => (
    <span className="truncate text-[11px] text-muted-foreground">{e.family ?? '—'}</span>
  ),
})

const detail = (label: string, pick: (e: RegistryEntity) => React.ReactNode): Column<RegistryEntity> => ({
  key: 'detail', label, render: pick,
})
