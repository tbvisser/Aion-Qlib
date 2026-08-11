/**
 * Every backtest this builder knows about, as an index over the canvas.
 *
 * The run dock below streams *one* run and is the right shape for that — a log
 * arrives a line at a time and wants width. What it was bad at was the other
 * question: what have I already tried? That lived in a `History` dropdown you
 * had to open to see, which is the wrong gesture for the thing you consult
 * while deciding what to change next.
 *
 * So the two split. This panel is the ledger, grouped by strategy so repeated
 * attempts at one idea sit together; the dock stays the live log.
 */
import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Columns2, ListTree } from 'lucide-react'

import { RunCompareModal } from '@/components/runs/RunCompareModal'
import { RunStatusIcon } from '@/components/runs/RunStatusIcon'
import { Badge } from '@/components/ui/badge'
import { useRunReports } from '@/hooks/useRunReports'
import type { Run, RunReport } from '@/lib/api'
import { changedSince, metricRow } from '@/lib/runMetrics'
import { cn } from '@/lib/utils'

const OPEN_KEY = 'aion.backtests.open'

export function BacktestsPanel({ runs, onOpenReport }: {
  runs: Run[]
  onOpenReport: (run: Run) => void
}) {
  // Open unless closed before.
  //
  // It defaulted to collapsed while the run dock still closed itself on finish,
  // and between them a finished backtest had nowhere to appear: the dock shut
  // and the ledger was a button nobody had been told about. The dock stays open
  // now, and this is the second place a result can land — a collapsed default
  // only makes sense for something the user already knows is there.
  const [open, setOpen] = useState(() => window.localStorage.getItem(OPEN_KEY) !== '0')
  /** The group being compared, if any. */
  const [comparing, setComparing] = useState<string | null>(null)
  // Fetched once for every succeeded run, gated and cached — so a row can show
  // its information ratio without each row opening its own request.
  const { reports } = useRunReports(open ? runs : [])

  const toggle = useCallback(() => {
    setOpen((prev) => {
      window.localStorage.setItem(OPEN_KEY, prev ? '0' : '1')
      return !prev
    })
  }, [])

  /**
   * Grouped by the strategy a run came from, falling back to its name.
   *
   * Runs started before a strategy was saved carry no `strategy_id`, and
   * grouping those under one "unsaved" heading would file unrelated experiments
   * together. Their name is the better key — it is what the spec was called.
   */
  const groups = useMemo(() => {
    const out = new Map<string, { label: string; runs: Run[] }>()
    for (const run of runs) {
      const key = run.strategy_id ?? run.name
      const group = out.get(key) ?? { label: run.name, runs: [] }
      group.runs.push(run)
      out.set(key, group)
    }
    return [...out.entries()].map(([key, group]) => ({ key, ...group }))
  }, [runs])

  if (!runs.length) return null

  return (
    <div
      data-testid="backtests-panel"
      className="absolute right-3 top-3 z-10 flex max-h-[calc(100%-1.5rem)] w-80 flex-col"
    >
      <button
        data-testid="backtests-toggle"
        onClick={toggle}
        aria-expanded={open}
        className="ml-auto flex items-center gap-2 rounded-lg border border-border/50 bg-card px-3 py-2 text-sm shadow-card transition-colors hover:bg-surface-3"
      >
        <ListTree className="h-4 w-4 text-muted-foreground" />
        Backtests
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {open && (
        <div className="mt-2 min-h-0 space-y-4 overflow-y-auto rounded-lg border border-border/50 bg-card p-3 shadow-card">
          {groups.map((group) => (
            <div key={group.key}>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  {group.label} · {group.runs.length} run{group.runs.length === 1 ? '' : 's'}
                </span>
                {group.runs.filter((r) => r.status === 'succeeded').length >= 2 && (
                  <button
                    data-testid={`compare-${group.key}`}
                    onClick={() => setComparing(group.key)}
                    title="Put these attempts side by side"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors hover:bg-surface-3"
                  >
                    <Columns2 className="h-3 w-3" />
                    Compare
                  </button>
                )}
              </div>
              {group.runs.map((run, i) => (
                <RunRow
                  key={run.id}
                  run={run}
                  report={reports[run.id]}
                  // The list is newest-first, so the *next* row is the attempt
                  // this one followed.
                  previous={group.runs[i + 1]}
                  onOpenReport={() => onOpenReport(run)}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {comparing && (
        <RunCompareModal
          open
          onClose={() => setComparing(null)}
          title={groups.find((g) => g.key === comparing)?.label}
          runs={(groups.find((g) => g.key === comparing)?.runs ?? [])
            .filter((r) => r.status === 'succeeded')}
        />
      )}
    </div>
  )
}

/**
 * One run, with the number that says whether it worked.
 *
 * The row used to carry a status badge and nothing else, so a ledger built to
 * answer "what have I already tried?" could not say how any of it went. The
 * information ratio is net of cost and is the same figure the report leads with.
 */
function RunRow({ run, report, previous, onOpenReport }: {
  run: Run
  report?: RunReport | null
  /** The attempt this one followed, for "what did I change?". */
  previous?: Run
  onOpenReport: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const done = run.status === 'succeeded'
  const metrics = metricRow(run, report)
  const changed = changedSince(previous, run)

  return (
    <div className="mb-1.5 rounded-lg bg-surface-2">
      <div className="flex items-center gap-2 px-3 py-2">
        <RunStatusIcon status={run.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {run.universe ?? run.model ?? '—'}
        </span>
        {done && metrics.ir != null ? (
          <span
            title="Information ratio, net of cost"
            className={cn('tnum shrink-0 font-mono text-[10px]',
                          metrics.ir > 0 ? 'text-primary' : 'text-clay')}
          >
            IR {metrics.ir.toFixed(2)}
          </span>
        ) : (
          <Badge variant={statusTone(run.status)} className="shrink-0">
            {run.status}
          </Badge>
        )}
        <button
          data-testid={`backtest-results-${run.id}`}
          disabled={!done}
          onClick={onOpenReport}
          className={cn(
            'shrink-0 rounded-md border border-border/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors',
            done
              ? 'hover:bg-surface-3'
              : 'cursor-not-allowed border-transparent text-muted-foreground/40',
          )}
        >
          Results
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? 'Hide details' : 'Show details'}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
        </button>
      </div>

      {expanded && (
        <div className="space-y-1 border-t border-border/50 px-3 py-2 font-mono text-[10px]">
          {/* What it was, first. "Experiment" and "Recorder" are mlflow's
              vocabulary, not the reader's, and they used to lead. */}
          <Detail
            label="Window"
            value={metrics.period ? `${metrics.period.start} → ${metrics.period.end}` : '—'}
          />
          <Detail label="Model" value={run.model ?? '—'} />
          <Detail label="Feature set" value={run.handler ?? '—'} />
          <Detail label="Universe" value={run.universe ?? '—'} />
          {changed && <Detail label="Changed" value={changed} />}
          <Detail label="Ann. excess" value={metrics.annualised == null
            ? '—' : `${(metrics.annualised * 100).toFixed(1)}%`} />
          <Detail label="Max drawdown" value={metrics.maxDrawdown == null
            ? '—' : `${(metrics.maxDrawdown * 100).toFixed(1)}%`} />
          <Detail label="Started" value={new Date(run.created_at).toLocaleString()} />
          {run.error_hint && (
            <p className="pt-1 font-sans text-[11px] leading-relaxed text-clay">
              {run.error_hint}
            </p>
          )}
          {run.error && (
            <details className="pt-1">
              <summary className="cursor-pointer text-muted-foreground/70">Traceback</summary>
              <p className="pt-1 leading-relaxed text-clay">{run.error}</p>
            </details>
          )}
          <details className="pt-1">
            <summary className="cursor-pointer text-muted-foreground/70">Diagnostics</summary>
            <div className="space-y-1 pt-1">
              <Detail label="Experiment" value={run.experiment_name} />
              <Detail label="Recorder" value={report?.recorder_id ?? '—'} />
            </div>
          </details>
        </div>
      )}
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground/70">{label}</span>
      <span className="min-w-0 truncate">{value}</span>
    </div>
  )
}

function statusTone(status: Run['status']): 'primary' | 'clay' | 'muted' {
  if (status === 'succeeded') return 'primary'
  if (status === 'failed') return 'clay'
  return 'muted'
}
