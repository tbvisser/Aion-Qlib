import { Link } from 'react-router-dom'
import { Inbox } from 'lucide-react'
import { Panel } from '@/components/ui/panel'
import { formatRunPercent, metricRow, metricTone, rankValue, type MetricRow } from '@/lib/runMetrics'
import { cn } from '@/lib/utils'
import type { Run, RunReport } from '@/lib/api'

interface Row {
  run: Run
  report: RunReport | null
}

export function LeaderboardPanel({
  rows,
  limit = 8,
  onTogglePick,
  picked,
}: {
  rows: readonly Row[]
  limit?: number
  onTogglePick?: (runId: string) => void
  picked?: readonly string[]
}) {
  const ranked = [...rows].sort(
    (a, b) => rankValue(metricRow(b.run, b.report)) - rankValue(metricRow(a.run, a.report)),
  )

  if (!ranked.length) {
    return (
      <Panel title="Leaderboard" hint="finished runs by IR" className="h-full min-h-[280px]">
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
          <Inbox className="h-5 w-5 text-muted-foreground/40" />
          <p>No finished runs yet.</p>
          <p className="max-w-[180px] text-[10px] leading-relaxed text-muted-foreground/60">
            Launch a sweep and the best learners will rank here.
          </p>
        </div>
      </Panel>
    )
  }

  const visible = ranked.slice(0, limit)

  return (
    <Panel
      title="Leaderboard"
      hint={`top ${Math.min(limit, ranked.length)} of ${ranked.length} finished runs`}
      className="h-full min-h-[280px]"
      flush
    >
      <div className="flex h-full flex-col">
        <div className="grid grid-cols-[28px_1fr_52px_52px_52px_52px_28px] gap-1 border-b border-border/50 bg-foreground/[0.02] px-2 py-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
          <span>#</span>
          <span>Run</span>
          <span className="text-right">IC</span>
          <span className="text-right">IR</span>
          <span className="text-right">Ann.</span>
          <span className="text-right">DD</span>
          <span />
        </div>

        <div className="flex-1 overflow-y-auto">
          {visible.map(({ run, report }, i) => {
            const row = metricRow(run, report)
            const selected = picked?.includes(run.id)
            return (
              <LeaderboardRow
                key={run.id}
                rank={i + 1}
                run={run}
                row={row}
                report={report}
                selected={selected}
                onToggle={onTogglePick ? () => onTogglePick(run.id) : undefined}
              />
            )
          })}
        </div>
      </div>
    </Panel>
  )
}

function LeaderboardRow({
  rank,
  run,
  row,
  report,
  selected,
  onToggle,
}: {
  rank: number
  run: Run
  row: MetricRow
  report: RunReport | null
  selected?: boolean
  onToggle?: () => void
}) {
  const ic = report?.metrics['IC'] ?? null

  return (
    <div
      className={cn(
        'grid grid-cols-[28px_1fr_52px_52px_52px_52px_28px] items-center gap-1 border-b border-border/30 px-2 py-1.5 transition-colors last:border-b-0',
        selected && 'bg-primary/[0.05]',
        !selected && 'hover:bg-foreground/[0.02]',
      )}
    >
      <RankBadge rank={rank} />

      <div className="min-w-0">
        <Link
          to={`/runs/${run.id}`}
          className="block truncate text-[11px] font-medium text-foreground hover:text-primary"
          title={run.name}
        >
          {run.name}
        </Link>
        <div className="flex items-center gap-1 text-[9px] text-muted-foreground/70">
          <span className="truncate">{run.model}</span>
          <span className="text-border">·</span>
          <span className="truncate">{run.handler}</span>
          {run.universe && run.benchmark && (
            <>
              <span className="hidden sm:inline text-border">·</span>
              <span className="hidden sm:inline truncate">{run.universe}/{run.benchmark}</span>
            </>
          )}
        </div>
      </div>

      <MetricCell value={ic} metric="annualised" digits={2} />
      <MetricCell value={row.ir} metric="annualised" digits={2} />
      <MetricCell value={row.annualised} metric="annualised" digits={0} />
      <MetricCell value={row.maxDrawdown} metric="maxDrawdown" digits={0} />

      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          title={selected ? 'Remove from compare' : 'Add to compare'}
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded border transition-colors',
            selected
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-border/40 text-muted-foreground hover:border-primary/30 hover:text-foreground',
          )}
        >
          <span className="text-[10px] leading-none">{selected ? '−' : '+'}</span>
        </button>
      )}
    </div>
  )
}

function RankBadge({ rank }: { rank: number }) {
  return (
    <div
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded text-[10px] font-medium',
        rank === 1 && 'bg-foreground/10 text-foreground',
        rank === 2 && 'bg-muted text-foreground',
        rank === 3 && 'bg-muted text-foreground',
        rank > 3 && 'text-muted-foreground/70',
      )}
    >
      {rank}
    </div>
  )
}

function MetricCell({
  value,
  metric,
  digits = 1,
}: {
  value: number | null
  metric: 'annualised' | 'maxDrawdown'
  digits?: number
}) {
  const tone = metricTone(metric, value ?? null)
  const text = value == null ? '—' : formatRunPercent(value, digits, false)

  return (
    <div className="flex items-center justify-end">
      <div
        className={cn(
          'tnum text-[11px] font-semibold',
          tone === 'positive' && 'text-primary',
          tone === 'negative' && 'text-clay',
          tone === null && 'text-muted-foreground',
        )}
      >
        {text}
      </div>
    </div>
  )
}
