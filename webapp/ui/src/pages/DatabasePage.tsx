import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ComingSoon } from '@/components/ComingSoon'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Notice } from '@/components/ui/notice'
import { Segmented } from '@/components/ui/segmented'
import {
  CatalogBrowser, ExpressionCell, NameCell, SourceBadge, type Column,
} from '@/components/database/CatalogBrowser'
import { CatalogOverview } from '@/components/database/CatalogOverview'
import { AlphaDetail } from '@/components/database/AlphaDetail'
import { useStoreMarks } from '@/components/database/useStoreMarks'
import { useCatalogFacets, useCatalogSearch, useCatalogSummary } from '@/hooks/useCatalog'
import {
  DATABASE_TABS, familyLabel, tabCount, tabFromParam, type DatabaseTab,
} from '@/lib/catalog'
import type { CatalogEntity, CatalogSource } from '@/lib/api'

/**
 * The Database: every asset the app knows about, in one place.
 *
 * This was the Databank — a factor-expression evaluator with a roadmap strip
 * naming the three things that were supposed to fold into it. It is now the
 * destination those things folded into, plus the Alpha Zoo, the Indicators
 * page, Markets, the Macro Desk, Documents and Corpus. Eight nav rows became
 * eight sub-tabs of one, which is the shape the content always had: they are
 * all "browse a collection of things".
 *
 * The sub-tab lives in `?tab=`, not in the path, so every folded-in route can
 * redirect to a real destination and land where its content went — see
 * `tabForLegacyRoute`, which App.tsx uses for exactly that.
 */
export function DatabasePage() {
  const [params, setParams] = useSearchParams()
  const tab = tabFromParam(params.get('tab'))
  const { summary, loading, error, reload } = useCatalogSummary()
  const [selected, setSelected] = useState<CatalogEntity | null>(null)

  const setTab = useCallback((next: DatabaseTab) => {
    // `replace` so the sub-tab bar does not fill the back button with eight
    // entries the user has to press through to leave the page.
    setParams((prev) => {
      const updated = new URLSearchParams(prev)
      updated.set('tab', next)
      return updated
    }, { replace: true })
    setSelected(null)
  }, [setParams])

  const options = useMemo(() => DATABASE_TABS.map((spec) => {
    const count = summary ? tabCount(spec, summary.collections) : 0
    return {
      value: spec.tab,
      label: count ? `${spec.label} ${count.toLocaleString()}` : spec.label,
      title: spec.soon ? `${spec.label} — not folded in yet` : undefined,
    }
  }), [summary])

  return (
    <>
      <PageHeader
        title="Database"
        description="Every alpha, indicator, backtest and document the platform knows about — from qlib, the curated library, the Vibe zoo and your own work, in one searchable place."
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-6 pt-4">
          <Segmented value={tab} options={options} onChange={setTab} buttonClassName="font-sans" />
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
            {error && <Notice tone="destructive">{error}</Notice>}
            {loading && !summary && (
              <div className="text-[12px] text-muted-foreground">Loading the catalog…</div>
            )}

            {summary && tab === 'overview' && (
              <CatalogOverview summary={summary} onReload={reload} onOpenTab={setTab} />
            )}

            {tab === 'alphas' && (
              <AlphasPanel
                selected={selected?.uid}
                onSelect={setSelected}
                // `/lab/alpha-zoo` redirects here with `source=vibe`, so an
                // Alpha Zoo bookmark still opens on the zoo rather than on all
                // 1,101 alphas — a different question than the page it replaced.
                initialSource={(params.get('source') as CatalogSource | null) ?? undefined}
              />
            )}

            {tab === 'indicators' && (
              <IndicatorsPanel selected={selected?.uid} onSelect={setSelected} />
            )}

            {summary && !['overview', 'alphas', 'indicators'].includes(tab) && (
              <NotFoldedInYet tab={tab} />
            )}
          </div>

          {/* The detail rail is the same for both: an indicator and an alpha
              are both a named expression you want to measure. */}
          {['alphas', 'indicators'].includes(tab) && selected && (
            <AlphaDetail uid={selected.uid} onClose={() => setSelected(null)} />
          )}
        </div>
      </div>
    </>
  )
}

const ALPHA_COLUMNS: Column<CatalogEntity>[] = [
  { key: 'name', label: 'Name', width: 'w-[38%]', render: (e) => <NameCell entity={e} /> },
  {
    key: 'source', label: 'Source', width: 'w-[12%]',
    render: (e) => <SourceBadge source={e.source} />,
  },
  {
    key: 'family', label: 'Family', width: 'w-[16%]',
    render: (e) => (
      <span className="truncate text-[11px] text-muted-foreground">{familyLabel(e)}</span>
    ),
  },
  {
    key: 'expression', label: 'Expression',
    render: (e) => <ExpressionCell entity={e} />,
  },
]

function AlphasPanel({
  selected, onSelect, initialSource,
}: {
  selected?: string
  onSelect: (entity: CatalogEntity) => void
  initialSource?: CatalogSource
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <p className="text-[12px] text-muted-foreground">
        qlib's Alpha158 and Alpha360 handler columns, the curated library, and the
        Vibe zoo's 462 — searchable together by name, description or expression.
        Pick one to read it; the ones written as qlib expressions can be measured
        here, and the zoo's run on the sidecar's own bench.
      </p>
      <CatalogBrowser
        kind="alpha"
        columns={ALPHA_COLUMNS}
        useData={useCatalogSearch}
        useFacets={useCatalogFacets}
        sort="name"
        selected={selected}
        onSelect={onSelect}
        initialSource={initialSource}
        emptyHint={
          <>Nothing indexed yet — build the catalog from the Overview tab.</>
        }
      />
    </div>
  )
}

/**
 * Alpha158's 184-expression vocabulary, plus the 44 operators it is written in
 * and the 6 that are refused.
 *
 * The refused six are listed rather than dropped: "why can't I use `Sum(x, 0)`?"
 * is a question a missing row answers with silence, and each carries its reason.
 *
 * Runnability comes from `useStoreMarks`, not the index. Whether `VWAP0` works
 * depends on which store is mounted, and the catalog is machine-independent by
 * construction — so the judgement is fetched and merged in rather than
 * harvested. The dead-and-trained-on banner is the claim that has to survive
 * the fold: nothing else in the app will tell you a strategy is fitting against
 * a column that is NaN on every row.
 */
function IndicatorsPanel({
  selected, onSelect,
}: {
  selected?: string
  onSelect: (entity: CatalogEntity) => void
}) {
  const [kind, setKind] = useState<'indicator' | 'operator'>('indicator')
  const marks = useStoreMarks()

  const columns = useMemo<Column<CatalogEntity>[]>(() => [
    { key: 'name', label: 'Name', width: 'w-[32%]', render: (e) => <NameCell entity={e} /> },
    {
      key: 'family', label: 'Family', width: 'w-[14%]',
      render: (e) => (
        <span className="truncate text-[11px] text-muted-foreground">{familyLabel(e)}</span>
      ),
    },
    {
      key: 'handler', label: 'In Alpha158', width: 'w-[11%]',
      render: (e) => {
        if (e.kind === 'operator') return <span className="text-muted-foreground/50">—</span>
        // 184 is the vocabulary; 158 is what a strategy actually trains on, and
        // the flag is matched on the expression rather than the name.
        return e.payload.in_handler
          ? <Badge variant="primary" className="font-normal">yes</Badge>
          : <span className="text-[11px] text-muted-foreground/60">no</span>
      },
    },
    {
      key: 'runs', label: 'Runs here', width: 'w-[11%]',
      render: (e) => {
        if (e.kind === 'operator') return <span className="text-muted-foreground/50">—</span>
        const mark = marks.byName.get(e.name)
        if (!mark || mark.runnable === null) {
          return <span className="text-[11px] text-muted-foreground/50">—</span>
        }
        if (mark.runnable === false) {
          return (
            <Badge variant="clay" className="font-normal" title={mark.note}>
              dead
            </Badge>
          )
        }
        if (mark.proxyFields?.length) {
          // Runs, but is not what its name promises — a different failure from
          // a dead column, and one a single "ok" badge would hide.
          return (
            <Badge variant="outline" className="font-normal" title={mark.note}>
              proxy
            </Badge>
          )
        }
        return <span className="text-[11px] text-muted-foreground/60">ok</span>
      },
    },
    { key: 'expression', label: 'Expression', render: (e) => <ExpressionCell entity={e} /> },
  ], [marks])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-[12px] text-muted-foreground">
          The vocabulary a factor is built out of, read from qlib rather than transcribed.
          184 expressions the generator can emit, 158 of which the Alpha158 handler
          actually trains on — and the operators they are written in.
        </p>
        <Segmented
          size="sm"
          value={kind}
          options={[
            { value: 'indicator', label: 'Indicators' },
            { value: 'operator', label: 'Operators' },
          ]}
          onChange={(v) => setKind(v as 'indicator' | 'operator')}
          buttonClassName="font-sans"
        />
      </div>

      {kind === 'indicator' && marks.deadAndTrainedOn.length > 0 && (
        <Notice tone="clay">
          <strong>{marks.deadAndTrainedOn.join(', ')}</strong>{' '}
          {marks.deadAndTrainedOn.length === 1 ? 'is' : 'are'} dead on the mounted store —
          the column {marks.deadAndTrainedOn.length === 1 ? 'it reads' : 'they read'} does not
          exist here, and qlib returns an empty series rather than failing.{' '}
          {marks.deadAndTrainedOn.length === 1 ? 'It is' : 'They are'} also part of the 158
          the Alpha158 handler trains on, so every strategy using that handler on this store
          is fitting against {marks.deadAndTrainedOn.length === 1 ? 'a column' : 'columns'} that
          {marks.deadAndTrainedOn.length === 1 ? ' is' : ' are'} NaN on every row — silently,
          and to the end of the backtest.
        </Notice>
      )}

      <CatalogBrowser
        kind={kind}
        columns={columns}
        useData={useCatalogSearch}
        useFacets={useCatalogFacets}
        sort="name"
        selected={selected}
        onSelect={onSelect}
        emptyHint={<>Nothing indexed yet — build the catalog from the Overview tab.</>}
      />
    </div>
  )
}

/**
 * A sub-tab whose page has not moved in yet.
 *
 * Named rather than hidden, for the same reason the sidebar lists its unbuilt
 * destinations: hiding them makes the app look finished and the plan invisible.
 * Each says which existing page folds into it, so an empty tab is never
 * mistaken for a broken one.
 */
const FOLDS_IN: Record<string, string> = {
  backtests: 'The Runs list, with its metrics columns, comparison and reports.',
  documents: 'Documents and Corpus. Papers and whitepapers stay in Supabase under row-level security and are federated in here rather than copied.',
  instruments: 'Markets, the data-source panel, and the store status and refresh dialog that is currently reachable only from inside the Strategy Builder.',
  macro: 'The Macro Desk — series, snapshot, curve, calendar and regime.',
  graph: 'Entities and the links between them, drawn from the catalog’s own link table.',
}

function NotFoldedInYet({ tab }: { tab: DatabaseTab }) {
  const spec = DATABASE_TABS.find((t) => t.tab === tab)
  return (
    <ComingSoon phase={`Database · ${spec?.label ?? tab}`}>
      {FOLDS_IN[tab] ?? 'Not built yet.'}
    </ComingSoon>
  )
}
