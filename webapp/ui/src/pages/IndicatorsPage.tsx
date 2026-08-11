/**
 * The Alpha158 expression vocabulary, browsable.
 *
 * 184 indicators laid out as groups × windows, because that is how they are
 * generated: 29 rolling families at five windows each, plus the candle features
 * and the price/volume lags. A flat list of 184 names hides that structure and
 * makes MA5 look unrelated to MA60.
 *
 * **184 is the vocabulary; the handler trains on 158.** The page used to claim
 * all of these were "the columns a strategy's handler trains on", which was
 * false for 26 of them — Alpha158 calls the same generator with a narrower
 * config. The toggle is the honest fix: keep everything, and let the reader ask
 * for only what actually reaches a model.
 *
 * The banners and the disabled cells are the point of the page rather than
 * decoration, and there are two of them because a column can fail in two ways.
 *
 * **Missing.** qlib returns an empty series for a missing column instead of
 * raising, so an indicator reading one evaluates to NaN through the handler,
 * through training, through the whole backtest, without an error anywhere.
 *
 * **A proxy.** The column is there and computes, but is not what it is called:
 * these stores' `$vwap` is typical price, written at ingest because no source
 * here carries an intraday volume-weighted price. Closing the missing-column gap
 * without saying this would have swapped a loud failure for a silent misreading.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, Play, Search } from 'lucide-react'

import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Notice } from '@/components/ui/notice'
import { IcMetrics } from '@/components/factors/IcResult'
import { icVerdict } from '@/components/factors/icVerdict'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  api, type DataStore, type Indicator, type IndicatorsResponse, type FactorEvaluation,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const FAMILY_ORDER = ['kbar', 'price', 'volume', 'rolling'] as const

export function IndicatorsPage() {
  const navigate = useNavigate()
  const [library, setLibrary] = useState<IndicatorsResponse | null>(null)
  const [stores, setStores] = useState<DataStore[]>([])
  const [store, setStore] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  const [onlyHandler, setOnlyHandler] = useState(false)
  const [selected, setSelected] = useState<Indicator | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.dataStores().then((r) => setStores(r.stores)).catch(() => setStores([]))
  }, [])

  useEffect(() => {
    setError(null)
    api.indicators(store)
      .then(setLibrary)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the library'))
  }, [store])

  const needle = query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!library) return []
    // One filter, both conditions. The sections memo below derives its windows
    // and groups from whatever survives, so an empty family disappears on its
    // own rather than needing a second code path for the toggle.
    return library.indicators.filter((i) => {
      if (onlyHandler && !i.in_handler) return false
      if (!needle) return true
      return i.name.toLowerCase().includes(needle)
        || i.group.toLowerCase().includes(needle)
        || i.description.toLowerCase().includes(needle)
        || i.expression.toLowerCase().includes(needle)
    })
  }, [library, needle, onlyHandler])

  // Rows are (family, group); columns are that family's windows. Built from the
  // data rather than from a hardcoded shape so a qlib version with a different
  // window list still renders.
  const sections = useMemo(() => {
    const out: { family: string; label: string; trained: number
                 windows: (number | null)[]
                 groups: { group: string; cells: (Indicator | null)[] }[] }[] = []
    for (const family of FAMILY_ORDER) {
      const rows = visible.filter((i) => i.family === family)
      if (!rows.length) continue
      const windows = [...new Set(rows.map((i) => i.window))]
        .sort((a, b) => (a ?? -1) - (b ?? -1))
      const groups = [...new Set(rows.map((i) => i.group))].map((group) => ({
        group,
        cells: windows.map((w) =>
          rows.find((i) => i.group === group && i.window === w) ?? null),
      }))
      out.push({
        family,
        label: library?.families.find((f) => f.key === family)?.label ?? family,
        // Counted over what is visible, so it stays right under a search rather
        // than reporting the family's full total against a filtered table.
        trained: rows.filter((i) => i.in_handler).length,
        windows,
        groups,
      })
    }
    return out
  }, [visible, library])

  const missing = library?.store.missing_columns ?? []
  // Computed over the whole library rather than `visible`: a column the handler
  // trains on is dead whether or not the current search happens to show it.
  const deadAndTrainedOn = (library?.indicators ?? [])
    .filter((i) => i.runnable === false && i.in_handler)
    .map((i) => i.name)

  return (
    <>
      <PageHeader
        title="Indicators"
        // Numbers read from the payload, never written down. The sentence this
        // replaces was a hardcoded claim that had already gone false.
        // The closing clause pairs this page with the Databank it now sits
        // beside in the nav: browse the ready-made ones here, write your own
        // there. Two pages, one sentence each, so neither has to be guessed at.
        description={library
          ? `Every expression qlib's Alpha158 generator emits — ${library.indicators.length} of them. `
            + `The ${library.handler.name} handler trains on ${library.handler.columns}; `
            + 'the rest are here to measure and to build factors from. '
            + 'To write one of your own, use the Databank.'
          : "qlib's ready-made Alpha158 expression vocabulary."}
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-border/50 p-0.5">
            {stores.map((s) => (
              <button
                key={s.key}
                onClick={() => setStore(s.key)}
                disabled={!s.exists}
                className={cn(
                  'rounded-md px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors',
                  (store ?? stores.find((x) => x.mounted)?.key) === s.key
                    ? 'bg-foreground/[0.07] text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                  !s.exists && 'opacity-40',
                )}
              >
                {s.key}
              </button>
            ))}
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-7xl space-y-4">
          {error && <Notice tone="destructive" icon={false}>{error}</Notice>}

          {missing.length > 0 && (
            <Notice tone="clay">
              <p className="text-foreground">
                This store has no{' '}
                <span className="font-mono">{missing.map((m) => `$${m}`).join(', ')}</span>{' '}
                column.
              </p>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                qlib returns an empty series for a missing column rather than failing, so the
                indicators below that read it evaluate to NaN on every row — silently, all the
                way through a backtest. They are greyed out here and refused in the canvas.
              </p>
              {deadAndTrainedOn.length > 0 && (
                // The sharper half. The rest of this banner is about
                // indicators you might choose; this is about columns a
                // strategy trains on whether you choose them or not.
                <p className="text-[13px] leading-relaxed text-foreground">
                  <span className="font-mono">{deadAndTrainedOn.join(', ')}</span>
                  {deadAndTrainedOn.length === 1 ? ' is one' : ' are'} of the{' '}
                  {library?.handler.columns} columns {library?.handler.name} trains on. A
                  strategy using that handler on this store fits against{' '}
                  {deadAndTrainedOn.length === 1 ? 'a dead column' : 'dead columns'} and
                  finishes without complaint.
                </p>
              )}
            </Notice>
          )}

          {Object.entries(library?.store.proxy_columns ?? {}).length > 0 && (
            // Muted, not clay: nothing here is broken. The columns compute —
            // they just measure something other than their name.
            <Notice tone="muted">
              {Object.entries(library!.store.proxy_columns).map(([field, sentence]) => (
                <p key={field} className="text-[13px] leading-relaxed">
                  <span className="font-mono">${field}</span> — {sentence}
                </p>
              ))}
            </Notice>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-64 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // The suggestions have to actually match something. "kurtosis"
                // used to be one of them and appears nowhere in the library.
                placeholder={`Search ${visible.length} indicators — try WVMA, MIN20, or $volume`}
                className="pl-9 font-mono text-sm"
              />
            </div>
            <label className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
              <Switch checked={onlyHandler} onCheckedChange={setOnlyHandler}
                      data-testid="only-handler" />
              Only what {library?.handler.name ?? 'the handler'} trains on
            </label>
          </div>

          {selected && (
            <Detail
              store={store ?? stores.find((x) => x.mounted)?.key}
              mountedStore={stores.find((x) => x.mounted)?.key}
              indicator={selected}
              onClose={() => setSelected(null)}
              // The name rides along so the column arrives called `MA5` rather
              // than `F2`. The canvas makes it unique if that is already taken.
              onOpen={() => navigate(
                `/lab/builder?mode=canvas&expression=${encodeURIComponent(selected.expression)}`
                + `&name=${encodeURIComponent(selected.name)}`)}
            />
          )}

          {!library && !error && (
            <p className="py-12 text-center text-sm text-muted-foreground">Loading the library…</p>
          )}

          {library && sections.length === 0 && (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Nothing matches “{query}”.
            </p>
          )}

          {sections.map((section) => (
            <div key={section.family} className="space-y-1.5">
              <div className="flex items-baseline gap-2">
                <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </h2>
                <span className="text-[11px] text-muted-foreground/60">
                  {section.groups.reduce(
                    (n, g) => n + g.cells.filter(Boolean).length, 0)}
                </span>
                {!onlyHandler && (
                  // The passive signal. Cells are not decorated individually:
                  // greying already means "cannot run here", and a second
                  // meaning on the same mark would make both ambiguous.
                  <span className="text-[11px] text-muted-foreground/60">
                    · {section.trained} trained on
                  </span>
                )}
              </div>
              <div className="overflow-x-auto rounded-lg border border-border/50">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="w-40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                        Group
                      </th>
                      {section.windows.map((w) => (
                        <th key={String(w)}
                            className="px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                          {w === null ? '—' : w}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.groups.map(({ group, cells }) => (
                      <tr key={group} className="border-b border-border/30 last:border-0">
                        <td className="px-3 py-1 font-mono text-xs text-muted-foreground">
                          {group}
                        </td>
                        {cells.map((indicator, i) => (
                          <td key={i} className="px-1 py-1">
                            {indicator && (
                              <button
                                data-testid={`indicator-${indicator.name}`}
                                disabled={indicator.runnable === false}
                                title={indicator.note ?? indicator.expression}
                                onClick={() => setSelected(indicator)}
                                className={cn(
                                  'w-full rounded px-2 py-1 text-left font-mono text-xs transition-colors',
                                  indicator.runnable === false
                                    ? 'cursor-not-allowed text-muted-foreground/40 line-through'
                                    : 'hover:bg-foreground/[0.06]',
                                  selected?.name === indicator.name && 'bg-foreground/[0.09]',
                                )}
                              >
                                {indicator.name}
                              </button>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

/** One indicator, with the two things you can do to it. */
function Detail({ indicator, onClose, onOpen, store, mountedStore }: {
  indicator: Indicator
  onClose: () => void
  onOpen: () => void
  /** The store the page is *showing*. */
  store?: string
  /** The store this API process actually mounted. */
  mountedStore?: string
}) {
  const [result, setResult] = useState<FactorEvaluation | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setResult(null)
    setError(null)
  }, [indicator.name])

  // `/factors/evaluate` reads whichever store this API process mounted — one
  // `qlib.init` per process, and it cannot be re-pointed per request. Measuring
  // a crypto indicator against US bars and reporting the number as if it meant
  // something is worse than declining to measure.
  const wrongStore = Boolean(store && mountedStore && store !== mountedStore)

  const evaluate = async () => {
    setRunning(true)
    setError(null)
    try {
      setResult(await api.evaluateFactor({
        expression: indicator.expression, horizon: 5, start: '2022-01-01',
      }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Evaluation failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card data-testid="indicator-detail">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-medium">{indicator.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                {indicator.group}
              </span>
              <span className={cn(
                'rounded px-1.5 py-0.5 font-mono text-[9px] uppercase',
                indicator.in_handler
                  ? 'bg-primary/10 text-primary'
                  : 'border border-border/50 text-muted-foreground',
              )}>
                {indicator.in_handler ? 'Alpha158' : 'not in Alpha158'}
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {indicator.description}
            </p>
            {!indicator.in_handler && (
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Part of the generated vocabulary but not the handler's config, so no strategy
                trains on it unless you build it into one. Still measurable, and still usable on
                the canvas.
              </p>
            )}
            <pre className="overflow-x-auto rounded bg-surface-2 p-2 font-mono text-[11px]">
              {indicator.expression}
            </pre>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>

        {indicator.note && (
          <p className="rounded-lg border border-clay/50 p-2.5 text-[12px] leading-relaxed text-muted-foreground">
            {indicator.note}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onOpen}>
            <ExternalLink className="h-4 w-4" />
            Open in canvas
          </Button>
          {/* aria-disabled rather than disabled: a disabled button swallows
              hover, and the title is the only place the reason is written. */}
          <Button
            size="sm"
            onClick={() => { if (!wrongStore && indicator.runnable !== false) void evaluate() }}
            aria-disabled={wrongStore || indicator.runnable === false}
            disabled={running}
            className={wrongStore || indicator.runnable === false
              ? 'pointer-events-auto opacity-50' : undefined}
            title={wrongStore
              ? `Measuring reads the store this API process mounted (${mountedStore}). `
                + `You are looking at ${store}, and a number measured against the wrong `
                + 'store is worse than no number.'
              : indicator.runnable === false
                ? 'This store cannot compute the columns it reads'
                : 'Cross-sectional IC against the 5-day forward return'}
          >
            <Play className="h-4 w-4" />
            {running ? 'Measuring…' : 'Evaluate'}
          </Button>
          {error && (
            <span className="ml-1 font-mono text-[11px] text-destructive">{error}</span>
          )}
        </div>

        {result && (
          <div className="space-y-2">
            <IcMetrics result={result} compact />
            {icVerdict(result) && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {icVerdict(result)}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

