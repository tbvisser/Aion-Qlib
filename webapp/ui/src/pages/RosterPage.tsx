import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { PageHeader } from '@/components/layout/PageHeader'
import { Notice } from '@/components/ui/notice'
import { Segmented } from '@/components/ui/segmented'
import {
  CatalogBrowser, NameCell, SourceBadge, type Column,
} from '@/components/database/CatalogBrowser'
import { RosterOverview } from '@/components/roster/RosterOverview'
import { RosterDetail } from '@/components/roster/RosterDetail'
import { AgentConsoles } from '@/components/roster/AgentConsoles'
import { SkillsPage } from '@/features/rag/pages/SkillsPage'
import { useRegistryFacets, useRegistrySearch, useRegistrySummary } from '@/hooks/useRegistry'
import {
  ROSTER_TABS, rosterTabCount, rosterTabFromParam, rosterTabSpec, type RosterTab,
} from '@/lib/roster'
import type { RegistryEntity } from '@/lib/api'

/**
 * Agents & Skills — the Database's twin.
 *
 * Same shell, same search box, same facet rail, same table and detail rail,
 * because they are the same act: browse a collection of things the platform
 * knows about. What differs is underneath. The Database reads one SQLite index;
 * this federates four backends live — the Vibe sidecar's 30 swarm teams, 89
 * skills, 34 allowlisted MCP tools and 5 playbooks; the vendored RAG backend's
 * 44 tools, 1 harness and 3 sub-agents; this API's own 2 chat profiles and 9
 * tools; and 3 file skills sitting in the repo.
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
    // `replace` so the sub-tab bar does not fill the back button with six
    // entries the user has to press through to leave the page.
    setParams((prev) => {
      const updated = new URLSearchParams(prev)
      updated.set('tab', next)
      return updated
    }, { replace: true })
    setSelected(null)
  }, [setParams])

  const options = useMemo(() => ROSTER_TABS.map((spec) => {
    const count = summary ? rosterTabCount(spec, summary.collections) : 0
    return {
      value: spec.tab,
      label: count ? `${spec.label} ${count.toLocaleString()}` : spec.label,
    }
  }), [summary])

  const browsing = rosterTabSpec(tab).kinds.length > 0

  return (
    <>
      <PageHeader
        title="Agents & Skills"
        description="Every swarm team, agent, skill and tool this platform can reach — from the Vibe sidecar, the RAG backend, this API and the repo, in one searchable place."
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-6 pt-4">
          <Segmented value={tab} options={options} onChange={setTab} />
        </div>

        <div className="flex min-h-0 flex-1">
          {tab === 'authored' ? (
            // The one tab that is not a collection: the user's own Supabase
            // rows, editable, behind their JWT. Mounted whole — it owns its
            // scroll and its two-column shell.
            <SkillsPage />
          ) : (
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
              {error && <Notice tone="destructive">{error}</Notice>}
              {loading && !summary && (
                <div className="text-[12px] text-muted-foreground">Reaching the backends…</div>
              )}

              {summary && tab === 'overview' && (
                <RosterOverview
                  summary={summary}
                  onRefresh={refresh}
                  refreshing={refreshing}
                  onOpenTab={setTab}
                />
              )}

              {tab === 'swarms' && <SwarmsPanel selected={selected?.uid} onSelect={setSelected} />}
              {tab === 'agents' && <AgentsPanel selected={selected?.uid} onSelect={setSelected} />}
              {tab === 'skills' && <SkillsPanel selected={selected?.uid} onSelect={setSelected} />}
              {tab === 'tools' && <ToolsPanel selected={selected?.uid} onSelect={setSelected} />}
            </div>
          )}

          {browsing && selected && (
            <RosterDetail uid={selected.uid} onClose={() => setSelected(null)} />
          )}
        </div>
      </div>
    </>
  )
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

function Panel({
  blurb, children, extra,
}: {
  blurb: React.ReactNode
  children: React.ReactNode
  extra?: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <p className="max-w-3xl text-[12px] text-muted-foreground">{blurb}</p>
      {extra}
      {children}
    </div>
  )
}

interface PanelProps {
  selected?: string
  onSelect: (row: RegistryEntity) => void
}

function browser(kind: string, columns: Column<RegistryEntity>[], props: PanelProps) {
  return (
    <CatalogBrowser<RegistryEntity>
      kind={kind}
      columns={columns}
      useData={useRegistrySearch}
      useFacets={useRegistryFacets}
      sort="name"
      selected={props.selected}
      onSelect={props.onSelect}
      searchPlaceholder={rosterTabSpec(
        kind === 'swarm' ? 'swarms' : kind === 'agent' ? 'agents'
          : kind === 'skill' ? 'skills' : 'tools',
      ).placeholder}
      emptyHint={<>Nothing reachable — check the Overview tab for which backend is down.</>}
    />
  )
}

// --- panels ---------------------------------------------------------------

function SwarmsPanel(props: PanelProps) {
  return (
    <Panel blurb={
      <>
        Multi-agent teams the sidecar can run: a fixed roster of role-specialised agents
        over a task graph. The Investment Committee is a bull-side researcher, a bear-side
        researcher, a risk officer and the PM who makes the call.
      </>
    }>
      {browser('swarm', [
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
      ], props)}
    </Panel>
  )
}

function AgentsPanel(props: PanelProps) {
  return (
    <Panel
      blurb={
        <>
          Everything that runs on its own: this API's chat profiles, the sidecar's scheduled
          playbooks, and the RAG backend's harness and sub-agents. A profile is a prompt plus
          a tool list — and the tools it does <em>not</em> have are its safety model, not an
          instruction.
        </>
      }
      // Folded in from its own nav row: an agent console among several rather
      // than a destination. It cannot be a table row — it is a live status probe
      // and a link out, because the sidecar forbids framing.
      extra={<AgentConsoles />}
    >
      {browser('agent', [
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
      ], props)}
    </Panel>
  )
}

function SkillsPanel(props: PanelProps) {
  return (
    <Panel blurb={
      <>
        Methodologies the assistant loads on demand rather than carrying in its prompt —
        the sidecar's library plus the file-based ones in this repo. To write your own,
        use the Your Skills tab.
      </>
    }>
      {browser('skill', [
        { ...NAME, width: 'w-[30%]' },
        SOURCE,
        family('Kind', 'w-[14%]'),
        detail('Description', (e) => (
          <span className="truncate text-[11px] text-muted-foreground">{e.summary ?? '—'}</span>
        )),
      ], props)}
    </Panel>
  )
}

function ToolsPanel(props: PanelProps) {
  return (
    <Panel blurb={
      <>
        Every callable the platform has, across three runtimes. The same tool can appear
        twice with different sources — the RAG backend reaches the sidecar over MCP, so
        it holds its own handle on tools the proxy also exposes directly.
      </>
    }>
      {browser('tool', [
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
      ], props)}
    </Panel>
  )
}
