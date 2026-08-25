import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MicroLabel } from '@/components/ui/micro-label'
import { Input } from '@/components/ui/input'
import { Notice } from '@/components/ui/notice'
import { sourceLabel } from '@/lib/catalog'
import type { CatalogFacetValue, CatalogFacets, CatalogSource } from '@/lib/api'
import { TableHeader } from '@/components/ui/table'
import type { Column } from '@/components/ui/table'
import { cn } from '@/lib/utils'

/**
 * The one browser every collection uses: search box, facet rail, table, paging.
 *
 * Written once and driven by a column spec rather than copied per sub-tab.
 * Twelve collections with twelve hand-rolled tables is twelve places for the
 * source badge to drift, and the badge is the thing that makes a merged view
 * readable at all — a row is only meaningful once you know whether "CORR20"
 * came from qlib, the curated library or the zoo, or whether
 * "get_options_chain" is the sidecar's tool or the RAG backend's.
 *
 * **Generic over the row, and over where rows come from.** The Database reads a
 * SQLite index through `/api/catalog/*`; Agents & Skills federates four
 * services live through `/api/registry/*`. Those are genuinely different data
 * layers, but they are not a different *table* — so the data source arrives as
 * two hooks rather than being imported, and everything below this line is the
 * same pixels for both pages.
 */

/** The shared row contract. Both endpoints return exactly this. */
export interface BrowserRow {
  uid: string
  kind: string
  source: string
  name: string
  title: string | null
  summary: string | null
  family: string | null
  tags: string[]
  payload: Record<string, unknown>
}

export interface BrowserQuery {
  q?: string
  kind?: string
  source?: string
  family?: string
  tag?: string
  sort?: string
  limit?: number
  offset?: number
}

export interface BrowserPage<T> {
  results: T[]
  total: number
  limit: number
  offset: number
  returned: number
}

export interface BrowserData<T> {
  page: BrowserPage<T> | null
  loading: boolean
  error: string | null
}

// The column contract now lives with the table primitives; re-exported so the
// Database and Roster imports keep working.
export type { Column } from '@/components/ui/table'

const PAGE = 50

/** The name cell every collection shares, so the first column is never bespoke. */
export function NameCell({ entity }: { entity: Pick<BrowserRow, 'name' | 'summary'> }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-caption text-foreground">{entity.name}</div>
      {entity.summary && (
        <div className="truncate text-label text-muted-foreground">{entity.summary}</div>
      )}
    </div>
  )
}

export function SourceBadge({ source }: { source: string }) {
  return (
    <Badge variant="outline" font="sans" className="text-micro font-normal">
      {sourceLabel(source)}
    </Badge>
  )
}

export function ExpressionCell({ entity }: { entity: { expression: string | null } }) {
  if (!entity.expression) return <span className="text-muted-foreground/50">—</span>
  return (
    <code className="block truncate font-sans text-label text-muted-foreground">
      {entity.expression}
    </code>
  )
}

function FacetGroup({
  title, values, active, onPick, labelFor,
}: {
  title: string
  values: CatalogFacetValue[]
  active: string | undefined
  onPick: (value: string | undefined) => void
  labelFor?: (value: string) => string
}) {
  const [expanded, setExpanded] = useState(false)
  if (!values.length) return null
  // Long tails are collapsed rather than scrolled: the rail is a filter, and a
  // 60-tag list buries the four facets that actually partition the collection.
  const shown = expanded ? values : values.slice(0, 8)

  return (
    <div className="space-y-1">
      <MicroLabel as="div">
        {title}
      </MicroLabel>
      {shown.map((facet) => {
        const on = active === facet.value
        return (
          <button
            key={facet.value}
            type="button"
            onClick={() => onPick(on ? undefined : facet.value)}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-label transition-colors',
              on ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="truncate">{labelFor ? labelFor(facet.value) : facet.value}</span>
            <span className="shrink-0 text-micro tabular-nums text-muted-foreground/70">
              {facet.count.toLocaleString()}
            </span>
          </button>
        )
      })}
      {values.length > 8 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="px-1.5 text-micro text-muted-foreground hover:text-foreground"
        >
          {expanded ? 'Show fewer' : `Show all ${values.length}`}
        </button>
      )}
    </div>
  )
}

export function CatalogBrowser<T extends BrowserRow>({
  kind,
  columns,
  rowKey = (row) => row.uid,
  useData,
  useFacets,
  sort = 'name',
  selected,
  onSelect,
  emptyHint,
  initialSource,
  searchPlaceholder = 'Search names, descriptions and expressions — try momentum, or $volume',
}: {
  /** The collection to browse. Undefined searches every kind at once. */
  kind?: string
  columns: Column<T>[]
  /** Row identity, for React keys and for the selected highlight. */
  rowKey?: (row: T) => string
  /**
   * Where rows come from. Passed rather than imported so the same table can sit
   * over the catalog's index and over the roster's live fan-out — see the note
   * at the top of this file.
   */
  useData: (query: BrowserQuery) => BrowserData<T>
  useFacets: (kind?: string) => CatalogFacets | null
  sort?: string
  selected?: string
  onSelect?: (row: T) => void
  /** What to say when the collection is empty rather than the filters strict. */
  emptyHint?: React.ReactNode
  /**
   * Source to open pre-filtered on. This is how a folded-in route keeps its
   * meaning: `/lab/alpha-zoo` redirects here, and landing on all 1,101 alphas
   * would answer a different question than the page it replaced.
   */
  initialSource?: CatalogSource
  searchPlaceholder?: string
}) {
  const [q, setQ] = useState('')
  const [source, setSource] = useState<string | undefined>(initialSource)
  const [family, setFamily] = useState<string>()
  const [tag, setTag] = useState<string>()
  const [offset, setOffset] = useState(0)

  // Any filter change starts the result set over. Keeping the offset would land
  // the user on page 4 of a 2-page result and show an empty table.
  useEffect(() => setOffset(0), [q, source, family, tag, kind])

  const query = useMemo<BrowserQuery>(
    () => ({ q: q || undefined, kind, source, family, tag, sort, limit: PAGE, offset }),
    [q, kind, source, family, tag, sort, offset],
  )
  const { page, loading, error } = useData(query)
  const facets = useFacets(kind)

  const filtered = Boolean(q || source || family || tag)
  const clear = () => { setQ(''); setSource(undefined); setFamily(undefined); setTag(undefined) }

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <aside className="hidden w-48 shrink-0 space-y-4 overflow-y-auto lg:block">
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clear} className="h-6 w-full justify-start px-1.5 text-label">
            <X className="mr-1 h-3 w-3" /> Clear filters
          </Button>
        )}
        <FacetGroup
          title="Source" values={facets?.source ?? []} active={source}
          onPick={setSource} labelFor={sourceLabel}
        />
        <FacetGroup title="Family" values={facets?.family ?? []} active={family} onPick={setFamily} />
        <FacetGroup title="Tag" values={facets?.tags ?? []} active={tag} onPick={setTag} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              spellCheck={false}
              placeholder={searchPlaceholder}
              className="h-8 pl-8 text-caption"
            />
          </div>
          <div className="shrink-0 text-label tabular-nums text-muted-foreground">
            {page ? `${page.total.toLocaleString()} result${page.total === 1 ? '' : 's'}` : '—'}
          </div>
        </div>

        {/* A failed request is destructive, not clay: nothing is telling you
            something you will not like, the search simply did not run. */}
        {error && <Notice tone="destructive">{error}</Notice>}

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border/50">
          <table className="w-full table-fixed border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="border-b border-border/50">
                {columns.map((column) => (
                  <TableHeader
                    key={column.key}
                    numeric={column.numeric}
                    className={column.width}
                  >
                    {column.label}
                  </TableHeader>
                ))}
              </tr>
            </thead>
            <tbody>
              {page?.results.map((row) => {
                const key = rowKey(row)
                return (
                  <tr
                    key={key}
                    onClick={() => onSelect?.(row)}
                    className={cn(
                      'border-b border-border/30 last:border-0',
                      onSelect && 'cursor-pointer hover:bg-foreground/[0.03]',
                      selected === key && 'bg-foreground/[0.05]',
                    )}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn('px-3 py-1.5 align-middle', column.numeric && 'text-right')}
                      >
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>

          {page && page.total === 0 && (
            <div className="p-8 text-center text-caption text-muted-foreground">
              {filtered ? (
                <>
                  Nothing matches those filters.{' '}
                  <button type="button" onClick={clear} className="underline hover:text-foreground">
                    Clear them
                  </button>
                  .
                </>
              ) : (
                emptyHint ?? 'This collection is empty.'
              )}
            </div>
          )}
          {!page && loading && (
            <div className="p-8 text-center text-caption text-muted-foreground">Loading…</div>
          )}
        </div>

        {page && page.total > PAGE && (
          <div className="flex shrink-0 items-center justify-between text-label text-muted-foreground">
            <span className="tabular-nums">
              {(page.offset + 1).toLocaleString()}–
              {(page.offset + page.returned).toLocaleString()} of {page.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost" size="sm" className="h-6 px-1.5"
                disabled={page.offset === 0}
                onClick={() => setOffset(Math.max(0, page.offset - PAGE))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost" size="sm" className="h-6 px-1.5"
                disabled={page.offset + page.returned >= page.total}
                onClick={() => setOffset(page.offset + PAGE)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
