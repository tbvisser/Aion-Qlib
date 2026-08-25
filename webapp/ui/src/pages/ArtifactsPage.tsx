import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, FileText, Image, LineChart, Plus, Table2 } from 'lucide-react'
import { IndexHeader } from '@/components/layout/IndexHeader'
import { Button } from '@/components/ui/button'
import { MicroLabel } from '@/components/ui/micro-label'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Notice } from '@/components/ui/notice'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { useArtifacts, type Artifact, type ArtifactKind } from '@/hooks/useArtifacts'
import { useRunReports } from '@/hooks/useRunReports'
import type { RunReport } from '@/lib/api'
import { previewTier } from '@/lib/artifactPreview'
import { formatRunPercent, type MetricRow } from '@/lib/runMetrics'
import { formatRelativeStamp } from '@/lib/time'

/**
 * Artifacts: everything the app has produced, whatever produced it.
 *
 * The tabs are sources, not filters over one store — see `useArtifacts` for why
 * they fail independently. A tab that is empty because its backend is down says
 * so; a tab that is empty because you haven't made anything yet says that
 * instead. The two are not the same news.
 */

type Tab = 'all' | ArtifactKind

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'backtest', label: 'Backtests' },
  { value: 'report', label: 'Reports' },
  { value: 'file', label: 'Files' },
]

/** Same cap as the backtest ledger: curves for the newest forty, the rest keep their summary or excerpt. */
const REPORT_LIMIT = 40

export function ArtifactsPage() {
  const navigate = useNavigate()
  const { artifacts, errors, loading } = useArtifacts()

  // Fetched off the full backtest list, not the visible one, so switching
  // tabs or typing a search does not restart the report fan-out.
  const backtestRuns = useMemo(
    () => artifacts.flatMap((a) => (a.kind === 'backtest' && a.run ? [a.run] : [])),
    [artifacts],
  )
  const { reports } = useRunReports(backtestRuns.slice(0, REPORT_LIMIT))

  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return artifacts.filter(
      (artifact) =>
        (tab === 'all' || artifact.kind === tab) &&
        (!needle ||
          artifact.title.toLowerCase().includes(needle) ||
          artifact.source.toLowerCase().includes(needle)),
    )
  }, [artifacts, tab, query])

  const open = async (artifact: Artifact) => {
    if (artifact.route) {
      navigate(artifact.route)
      return
    }
    if (!artifact.resolveHref) return
    // Signed URLs are minted on demand; a popup blocked here is better than
    // dozens of pre-signed links the user never clicks.
    const href = await artifact.resolveHref()
    window.open(href, '_blank', 'noopener,noreferrer')
  }

  const inTab = (kind: ArtifactKind) => artifacts.some((a) => a.kind === kind)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <IndexHeader
        title="Artifacts"
        search={{
          value: query,
          onChange: setQuery,
          open: searchOpen,
          onOpenChange: setSearchOpen,
          placeholder: 'Search artifacts…',
        }}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Plus className="mr-1 h-3.5 w-3.5" /> New artifact
                <ChevronDown className="ml-1 h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => navigate('/lab/builder')}>
                Run a backtest
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate('/lab/shadow-accounts')}>
                Render a shadow report
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate('/documents')}>
                Upload a document
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-5xl space-y-4">
          <Segmented<Tab> value={tab} options={TABS} onChange={setTab} data-testid="artifacts-tabs" />

          {errors.backtests && (tab === 'all' || tab === 'backtest') && (
            <Notice tone="destructive">{errors.backtests}</Notice>
          )}
          {errors.files && (tab === 'all' || tab === 'file') && (
            <Notice tone="destructive">{errors.files}</Notice>
          )}

          {/* The Reports tab is one card at most, and usually none. Saying why
              beats an empty grid that reads as broken. */}
          {tab === 'report' && !inTab('report') && !loading && (
            <Notice tone="muted">
              The Vibe sidecar keeps one shadow profile at a time and has no endpoint to list
              past reports, so a report shows here only once you have rendered one. Start from
              Shadow Accounts.
            </Notice>
          )}

          {loading && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-52 rounded-xl" />
              ))}
            </div>
          )}

          {!loading && visible.length === 0 && !(tab === 'report' && !inTab('report')) && (
            <EmptyState
              title={artifacts.length === 0
                ? 'Nothing generated yet. Run a backtest, or let an agent write a file, and it lands here.'
                : query
                  ? `Nothing matches “${query}”.`
                  : 'Nothing of this kind yet.'}
            />
          )}

          {!loading && visible.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((artifact) => (
                <ArtifactCard
                  key={artifact.id}
                  artifact={artifact}
                  report={artifact.run ? reports[artifact.run.id] : undefined}
                  onOpen={() => void open(artifact)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ArtifactCard({
  artifact,
  report,
  onOpen,
}: {
  artifact: Artifact
  report?: RunReport | null
  onOpen: () => void
}) {
  return (
    <Card
      data-testid={`artifact-card-${artifact.id}`}
      onClick={onOpen}
      className="cursor-pointer overflow-hidden transition-colors hover:border-border"
    >
      <div className="flex aspect-[4/3] items-center justify-center border-b border-border/50 bg-surface-2 p-4">
        <ArtifactPreview artifact={artifact} report={report} />
      </div>
      <CardContent className="space-y-1 p-3">
        <p className="truncate text-sm font-medium" title={artifact.title}>
          {artifact.title}
        </p>
        <p className="font-mono text-label text-muted-foreground/70">
          {artifact.source}
          {artifact.updatedAt && ` · ${formatRelativeStamp(artifact.updatedAt)}`}
        </p>
      </CardContent>
    </Card>
  )
}

/**
 * What the card shows above the fold. A backtest always has something worth
 * reading — a curve once its report arrives, headline numbers before that,
 * and failing both, an excerpt of what the run *was* (see `previewTier`).
 * A file has only its type, so it gets a glyph rather than a fake thumbnail
 * of content nobody rendered.
 */
function ArtifactPreview({ artifact, report }: { artifact: Artifact; report?: RunReport | null }) {
  const run = artifact.kind === 'backtest' ? artifact.run : undefined
  // Memoised because every arriving report re-renders the whole grid, and
  // this call decimates a daily curve when it lands on the curve tier.
  const tier = useMemo(() => (run ? previewTier(run, report) : null), [run, report])

  if (!tier) {
    const Icon = glyphFor(artifact)
    return <Icon className="h-8 w-8 text-muted-foreground/50" />
  }

  switch (tier.kind) {
    case 'status':
      return (
        <div className="space-y-2 text-center">
          <MicroLabel as="div" className="text-label">
            {tier.status}
          </MicroLabel>
          {tier.hint && (
            <p className="line-clamp-3 text-label text-muted-foreground">{tier.hint}</p>
          )}
        </div>
      )
    case 'curve':
      return (
        <div className="flex h-full w-full flex-col justify-between gap-3">
          <PreviewCurve values={tier.values} className="min-h-0 w-full flex-1" />
          <StatRow row={tier.row} />
        </div>
      )
    case 'stats':
      return <StatRow row={tier.row} />
    case 'facts':
      return (
        <dl className="w-full space-y-1.5">
          {tier.lines.map((line) => (
            <div key={line.label} className="flex items-baseline justify-between gap-3">
              <MicroLabel as="dt" className="shrink-0 text-tiny">
                {line.label}
              </MicroLabel>
              <dd className="truncate text-label text-muted-foreground">{line.value}</dd>
            </div>
          ))}
        </dl>
      )
  }
}

function StatRow({ row }: { row: MetricRow }) {
  return (
    <div className="grid w-full grid-cols-3 gap-2 text-center">
      <Stat label="IR" value={row.ir == null ? '—' : row.ir.toFixed(2)} />
      <Stat
        label="Ann."
        value={row.annualised == null ? '—' : formatRunPercent(row.annualised)}
      />
      <Stat
        label="Max DD"
        value={row.maxDrawdown == null ? '—' : formatRunPercent(row.maxDrawdown)}
      />
    </div>
  )
}

/**
 * The card's equity curve. Hand-rolled like `components/Sparkline` (a grid of
 * forty Recharts trees is forty resize observers), and scaled min→max like it
 * too rather than 0→max, because a cumulative return spends real time below
 * zero and clamping it there would redraw losses as gains. Nulls split the
 * segments, so a gap in the data reads as a gap. Colour follows Sparkline's
 * `signed` convention: primary rising, clay falling.
 */
function PreviewCurve({ values, className }: { values: (number | null)[]; className?: string }) {
  const W = 120
  const H = 72
  const TOP = 5
  const BOTTOM = 2

  const finite = values.filter((v): v is number => v != null && Number.isFinite(v))
  if (finite.length < 2) return null

  const min = Math.min(...finite)
  const max = Math.max(...finite)
  const span = max - min || 1
  const step = W / Math.max(values.length - 1, 1)
  const y = (v: number) => H - BOTTOM - ((v - min) / span) * (H - TOP - BOTTOM)

  // One path per unbroken run of points.
  const segments: [number, number][][] = []
  let current: [number, number][] = []
  values.forEach((value, i) => {
    if (value == null || !Number.isFinite(value)) {
      if (current.length > 1) segments.push(current)
      current = []
      return
    }
    current.push([i * step, y(value)])
  })
  if (current.length > 1) segments.push(current)
  if (!segments.length) return null

  const lastSegment = segments[segments.length - 1]
  const [lastX, lastY] = lastSegment[lastSegment.length - 1]
  const rising = finite[finite.length - 1] >= finite[0]
  const color = rising ? 'hsl(var(--primary))' : 'hsl(var(--clay))'

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden
    >
      {segments.map((segment, i) => {
        const line = segment
          .map(([x, py], j) => `${j === 0 ? 'M' : 'L'}${x.toFixed(2)},${py.toFixed(2)}`)
          .join(' ')
        const area = `${line} L${segment[segment.length - 1][0].toFixed(2)},${H} L${segment[0][0].toFixed(2)},${H} Z`
        return (
          <g key={i}>
            <path d={area} fill={color} fillOpacity={0.1} />
            <path
              d={line}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )
      })}
      <circle cx={lastX} cy={lastY} r={3} fill={color} stroke="hsl(var(--card))" strokeWidth={1.5} />
    </svg>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      {/* Always label the number — a bare figure on a card is a riddle. */}
      <MicroLabel as="div" className="text-tiny">
        {label}
      </MicroLabel>
      <p className="truncate font-mono text-sm text-foreground">{value}</p>
    </div>
  )
}

function glyphFor(artifact: Artifact) {
  if (artifact.kind === 'report') return LineChart
  const type = artifact.contentType ?? ''
  const name = artifact.title.toLowerCase()
  if (type.startsWith('image/')) return Image
  if (type.includes('csv') || name.endsWith('.csv') || name.endsWith('.parquet')) return Table2
  return FileText
}
