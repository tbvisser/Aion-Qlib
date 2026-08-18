import { useEffect, useState } from 'react'
import { Search, ChevronDown, ChevronUp } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import type { SegmentedOption } from '@/components/ui/segmented'
import { api, ApiError } from '@/lib/api'
import type { VibeSymbolCandidate } from '@/lib/api'
import { useDebouncedValue } from '@/features/rag/hooks/useDebouncedValue'
import { cn } from '@/lib/utils'

// ── Local types ────────────────────────────────────────────────────────────

type StatementType = 'balance' | 'income' | 'cashflow' | 'indicators'
type PeriodType = 'annual' | 'quarter'
type DetailTab = 'profile' | 'financials'

// ── Helpers ────────────────────────────────────────────────────────────────

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/** Profile is only offered for US and HK tickers per sidecar coverage. */
function isProfileAvailable(candidate: VibeSymbolCandidate): boolean {
  const m = candidate.market.toUpperCase()
  return m === 'US' || m === 'HK'
}

// ── Shared micro-components ────────────────────────────────────────────────

function SectionSpinner() {
  return (
    <div className="flex items-center gap-1.5 py-2">
      <div className="h-2.5 w-2.5 animate-spin rounded-full border border-border border-t-primary/60" />
      <span className="text-[11px] text-muted-foreground/60">Loading…</span>
    </div>
  )
}

function InlineError({ message }: { message: string }) {
  return (
    <p className="rounded-md bg-destructive/5 px-2.5 py-1.5 font-mono text-[11px] text-destructive/80">
      {message}
    </p>
  )
}

function Attribution({ source }: { source: string }) {
  return (
    <p className="mt-2 text-[10px] text-muted-foreground/40">
      via Vibe-Trading sidecar · sources: {source}
    </p>
  )
}

// ── Data renderers ─────────────────────────────────────────────────────────

/**
 * Renders a flat key/value grid for a Record with primitive values.
 * Non-primitive values (arrays, objects) are silently skipped.
 */
function KvGrid({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => isPrimitive(v))
  if (!entries.length) {
    return <p className="text-[11px] text-muted-foreground/50">—</p>
  }
  return (
    <dl className="grid grid-cols-[1fr_1fr] gap-x-4 gap-y-0.5">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55">
            {k.replace(/_/g, ' ')}
          </dt>
          <dd className="truncate font-mono text-[11px] text-foreground/80">
            {String(v ?? '—')}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Renders an array of flat objects as a horizontally-scrollable table.
 * Only columns whose values are primitives are included.
 */
function FlatTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Array.from(
    new Set(rows.flatMap((r) => Object.keys(r).filter((k) => isPrimitive(r[k])))),
  )
  if (!cols.length) {
    return <p className="text-[11px] text-muted-foreground/50">No readable columns.</p>
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border/50">
      <table className="min-w-full border-collapse font-mono text-[11px]">
        <thead>
          <tr className="bg-foreground/[0.02]">
            {cols.map((c) => (
              <th
                key={c}
                scope="col"
                className="whitespace-nowrap border-b border-border/50 px-2.5 py-1.5 text-left text-[10px] uppercase tracking-wider text-muted-foreground/55"
              >
                {c.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              // Rows lack stable keys; position is the closest proxy.
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              className="border-b border-border/30 last:border-0 odd:bg-foreground/[0.01]"
            >
              {cols.map((c) => (
                <td key={c} className="whitespace-nowrap px-2.5 py-1 text-foreground/80">
                  {String(row[c] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Dispatches between table and KV views based on the envelope data shape. */
function FinancialsData({ data }: { data: unknown }) {
  if (
    Array.isArray(data) &&
    data.length > 0 &&
    typeof data[0] === 'object' &&
    data[0] !== null
  ) {
    return <FlatTable rows={data as Record<string, unknown>[]} />
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return <KvGrid data={data as Record<string, unknown>} />
  }
  return <p className="text-[11px] text-muted-foreground/50">No data available.</p>
}

// ── Profile section ────────────────────────────────────────────────────────

function ProfileView({ ticker }: { ticker: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    api
      .vibeStockProfile(ticker)
      .then((r) => {
        if (cancelled) return
        setSource(r.result.source)
        if (!r.result.ok) {
          setError(r.result.error ?? 'Profile not available.')
        } else {
          setData(r.result.data as Record<string, unknown>)
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof ApiError ? e.message : 'Failed to load profile.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [ticker])

  if (loading) return <SectionSpinner />
  if (error) return <InlineError message={error} />
  if (!data) return null

  const sections = Object.entries(data)
  const renderable = sections.filter(([, v]) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    return Object.values(v as Record<string, unknown>).some(isPrimitive)
  })

  if (!renderable.length) {
    return <p className="text-[11px] text-muted-foreground/50">No profile data available.</p>
  }

  return (
    <div className="space-y-3">
      {renderable.map(([sectionKey, sectionData]) => (
        <div key={sectionKey}>
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55">
            {sectionKey.replace(/_/g, ' ')}
          </div>
          <KvGrid data={sectionData as Record<string, unknown>} />
        </div>
      ))}
      {source && <Attribution source={source} />}
    </div>
  )
}

// ── Financials section ─────────────────────────────────────────────────────

const STATEMENT_OPTIONS: readonly SegmentedOption<StatementType>[] = [
  { value: 'indicators', label: 'KPIs' },
  { value: 'income', label: 'Income' },
  { value: 'balance', label: 'Balance' },
  { value: 'cashflow', label: 'Cash Flow' },
]

const PERIOD_OPTIONS: readonly SegmentedOption<PeriodType>[] = [
  { value: 'annual', label: 'Annual' },
  { value: 'quarter', label: 'Quarterly' },
]

function FinancialsView({ code }: { code: string }) {
  const [statement, setStatement] = useState<StatementType>('indicators')
  const [period, setPeriod] = useState<PeriodType>('annual')
  const [data, setData] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    api
      .vibeFinancials(code, statement, period)
      .then((r) => {
        if (cancelled) return
        setSource(r.result.source)
        if (!r.result.ok) {
          setError(r.result.error ?? 'Financials not available.')
        } else {
          setData(r.result.data)
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof ApiError ? e.message : 'Failed to load financials.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [code, statement, period])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Segmented<StatementType>
          size="sm"
          value={statement}
          options={STATEMENT_OPTIONS}
          onChange={setStatement}
        />
        <Segmented<PeriodType>
          size="sm"
          value={period}
          options={PERIOD_OPTIONS}
          onChange={setPeriod}
        />
      </div>
      {loading && <SectionSpinner />}
      {!loading && error && <InlineError message={error} />}
      {!loading && !error && data != null && <FinancialsData data={data} />}
      {!loading && !error && source && <Attribution source={source} />}
    </div>
  )
}

// ── Candidate detail panel ─────────────────────────────────────────────────

const DETAIL_TABS: readonly SegmentedOption<DetailTab>[] = [
  { value: 'profile', label: 'Profile' },
  { value: 'financials', label: 'Financials' },
]

function CandidateDetail({ candidate }: { candidate: VibeSymbolCandidate }) {
  const hasProfile = isProfileAvailable(candidate)
  const [tab, setTab] = useState<DetailTab>(hasProfile ? 'profile' : 'financials')

  const availableTabs = DETAIL_TABS.filter((t) => t.value !== 'profile' || hasProfile)

  return (
    <div className="space-y-2.5">
      {/* Identity row */}
      <div className="flex items-center gap-2 border-t border-border/50 pt-2.5">
        <span className="font-mono text-xs font-semibold tracking-tight">{candidate.symbol}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80">
          {candidate.name}
        </span>
        <Badge variant="muted">{candidate.market}</Badge>
        {candidate.type && (
          <Badge variant="outline">{candidate.type}</Badge>
        )}
      </div>

      {/* Tab bar — only shown when profile is available (otherwise only financials) */}
      {availableTabs.length > 1 && (
        <Segmented<DetailTab>
          size="sm"
          value={tab}
          options={availableTabs}
          onChange={setTab}
        />
      )}

      {tab === 'profile' && hasProfile && <ProfileView ticker={candidate.symbol} />}
      {tab === 'profile' && !hasProfile && (
        <p className="text-[11px] text-muted-foreground/50">
          Profile data is only available for US and HK tickers.
        </p>
      )}
      {tab === 'financials' && <FinancialsView code={candidate.symbol} />}
    </div>
  )
}

// ── Main exported component ────────────────────────────────────────────────

/**
 * "More Sources" lookup panel for the Markets page.
 *
 * Surfaces the Vibe-Trading sidecar's symbol search, company profiles, and
 * financial statements across 18+ providers (Yahoo Finance, Eastmoney, etc.).
 * Self-contained: no store writes, no interaction with the qlib catalog.
 */
export function DataSourcesPanel() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [candidates, setCandidates] = useState<VibeSymbolCandidate[]>([])
  const [selected, setSelected] = useState<VibeSymbolCandidate | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchSource, setSearchSource] = useState<string | undefined>()
  const [offline, setOffline] = useState(false)

  const debouncedQuery = useDebouncedValue(query, 400)

  // Probe sidecar health whenever the panel is opened.
  useEffect(() => {
    if (!open) return
    api
      .vibeHealth()
      .then((r) => setOffline(r.status !== 'ok'))
      .catch(() => setOffline(true))
  }, [open])

  // Symbol search, debounced and race-guarded.
  useEffect(() => {
    if (!open || !debouncedQuery.trim()) {
      setCandidates([])
      setSearchError(null)
      setSearchSource(undefined)
      return
    }
    let cancelled = false
    setSearching(true)
    setSearchError(null)
    api
      .vibeSymbolSearch(debouncedQuery.trim())
      .then((r) => {
        if (cancelled) return
        setSearchSource(r.result.source ?? undefined)
        setCandidates(r.result.data?.candidates ?? [])
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 502) {
          setOffline(true)
        } else {
          setSearchError(e instanceof Error ? e.message : 'Search failed.')
        }
        setCandidates([])
      })
      .finally(() => {
        if (!cancelled) setSearching(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, debouncedQuery])

  const showCandidates = !selected && candidates.length > 0 && !searchError

  return (
    <Panel
      title="More Sources"
      hint={open ? 'Yahoo · Eastmoney · 18+ providers' : undefined}
      actions={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? 'Collapse more sources panel' : 'Expand more sources panel'}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-foreground"
        >
          {open ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
      }
    >
      {!open && (
        <p className="text-[11px] text-muted-foreground/50">
          Search Yahoo Finance, Eastmoney, and 18+ other providers.{' '}
          <button
            type="button"
            className="text-primary/70 underline-offset-2 hover:text-primary hover:underline"
            onClick={() => setOpen(true)}
          >
            Expand
          </button>
        </p>
      )}

      {open && (
        <div className="space-y-2">
          {/* Sidecar offline notice — quiet, actionable */}
          {offline && (
            <p className="rounded-md bg-muted px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground/70">
              Vibe sidecar offline —{' '}
              <code className="text-muted-foreground">
                infra\stack.ps1 up
              </code>
            </p>
          )}

          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            {searching && (
              <div className="absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin rounded-full border border-border border-t-primary/60" />
            )}
            <Input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setSelected(null)
              }}
              placeholder="Search ticker or name across all sources…"
              className="h-8 pl-8 pr-8 text-xs"
              disabled={offline}
              aria-label="Search external symbol sources"
            />
          </div>

          {/* Search error */}
          {searchError && <InlineError message={searchError} />}

          {/* Candidate list */}
          {showCandidates && (
            <div
              className="max-h-52 overflow-y-auto rounded-md border border-border/50"
              role="listbox"
              aria-label="Symbol search results"
            >
              {candidates.map((c) => (
                <button
                  key={`${c.symbol}:${c.source ?? c.market}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => setSelected(c)}
                  className={cn(
                    'block w-full border-b border-border/30 px-2.5 py-1.5 text-left transition-colors last:border-0',
                    'hover:bg-foreground/[0.04]',
                  )}
                >
                  <span className="mr-2 font-mono text-[11px] font-medium">{c.symbol}</span>
                  <span className="text-[11px] text-muted-foreground/80">{c.name}</span>
                  <span className="ml-2 inline-flex gap-1">
                    <Badge variant="muted">{c.market}</Badge>
                    {c.source && <Badge variant="outline">{c.source}</Badge>}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Empty state after a search settles */}
          {!searching && !searchError && debouncedQuery.trim() && candidates.length === 0 && !selected && (
            <p className="text-[11px] text-muted-foreground/50">No matches found.</p>
          )}

          {/* Attribution below the candidate list */}
          {showCandidates && searchSource && (
            <p className="text-[10px] text-muted-foreground/40">
              via Vibe-Trading sidecar · sources: {searchSource}
            </p>
          )}

          {/* Candidate detail */}
          {selected && (
            <div>
              <button
                type="button"
                className="mb-2 font-mono text-[10px] text-muted-foreground/55 underline-offset-2 hover:text-muted-foreground hover:underline"
                onClick={() => setSelected(null)}
              >
                ← back to results
              </button>
              <CandidateDetail candidate={selected} />
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
