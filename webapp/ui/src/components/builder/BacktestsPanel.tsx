/**
 * Every backtest this builder has run, and the one running now.
 *
 * These were two surfaces: a bottom dock streaming one run's log, and a
 * floating ledger of what had already been tried. The split was deliberate —
 * a log arrives a line at a time and wants width — but it meant a finished run
 * appeared in one place and a running one in another, and the two disagreed
 * about which run you were looking at. One panel now: rows are the ledger, and
 * expanding the live row is the log.
 *
 * ## The single-stream rule
 *
 * There is exactly **one** `useRunStream`, hoisted here — never one per row.
 * That is what makes collapsing the panel safe: the hook is mounted on the
 * panel, which stays mounted, so only the body is conditionally rendered and
 * the EventSource keeps accumulating lines. Move it into `RunRow` to
 * "simplify" and collapsing a row or the panel kills the stream mid-backtest,
 * and the log restarts from offset 0 on the next expand.
 *
 * `MAX_CONCURRENT_RUNS` is 1 in the runner, so a second start is queued rather
 * than concurrent. Other active runs render from the polled list, which for a
 * queued run says exactly that. Do not multiplex EventSources.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ChevronDown, ChevronUp, Columns2, ExternalLink, ListTree, Trash2,
} from 'lucide-react'

import { RunCompareModal } from '@/components/runs/RunCompareModal'
import { RunLog } from '@/components/runs/RunLog'
import { RunStatusIcon } from '@/components/runs/RunStatusIcon'
import { Button } from '@/components/ui/button'
import { isActive, useRunStream } from '@/hooks/useRunStream'
import { useRunReports } from '@/hooks/useRunReports'
import type { Run, RunReport } from '@/lib/api'
import { groupRuns } from '@/lib/runGroups'
import { changedSince, metricRow, metricTone, type MetricKey } from '@/lib/runMetrics'
import { cn } from '@/lib/utils'

const OPEN_KEY = 'aion.backtests.open'
/**
 * How many runs get their report fetched.
 *
 * The panel is mounted over both panes now, against a 500-run list. Far more
 * than fits on screen, and it caps a cold-cache burst at ten waves of four
 * qlib-backed disk reads rather than 125.
 */
const REPORT_LIMIT = 40

export interface BacktestsPanelProps {
  /** Every run, newest first. Owned by the page and shared. */
  runs: Run[]
  /** Runs launched from this tab, newest first. These auto-expand and stream. */
  sessionRunIds: string[]
  /** The Run `startRun` just returned, shown before the stream speaks. */
  seedRun: Run | null
  /** The saved strategy open in the builder; its group sorts first. */
  strategyId?: string
  /** Refetch the shared run list when the followed run reaches a terminal status. */
  onFinish: () => void
  onOpenReport: (run: Run) => void
  onDeleteRun: (run: Run) => Promise<void>
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BacktestsPanel({
  runs, sessionRunIds, seedRun, strategyId, onFinish, onOpenReport, onDeleteRun,
  open, onOpenChange,
}: BacktestsPanelProps) {
  const [comparing, setComparing] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  // Session run first, else this strategy's newest still-active run. The dock's
  // selection rule, kept verbatim: it is what made reopening a saved strategy
  // show how it last did.
  const liveRunId = sessionRunIds[0]
    ?? runs.find((r) => isActive(r) && (!strategyId || r.strategy_id === strategyId))?.id
    ?? null

  // ONE stream. See the module docblock before moving this.
  const { run: live, log, cancel, cancelling, stalled } =
    useRunStream(liveRunId, onFinish, seedRun)

  // Fetched once per succeeded run, gated and module-cached, so a row can show
  // its numbers without each row opening its own request.
  const { reports } = useRunReports(open ? runs.slice(0, REPORT_LIMIT) : [])

  const toggle = useCallback(() => {
    onOpenChange(!open)
    window.localStorage.setItem(OPEN_KEY, open ? '0' : '1')
  }, [open, onOpenChange])

  // A newly started run expands its row and opens the panel. A run restored
  // from sessionStorage after a reload expands too, but must NOT override a
  // panel the user deliberately collapsed — that is the whole point of the ref.
  const latestSession = sessionRunIds[0]
  const restored = useRef(sessionRunIds[0])
  useEffect(() => {
    if (!latestSession) return
    setExpanded((prev) => ({ ...prev, [latestSession]: true }))
    if (latestSession !== restored.current) onOpenChange(true)
  }, [latestSession, onOpenChange])

  const groups = useMemo(() => groupRuns(runs, strategyId), [runs, strategyId])

  return (
    <div
      data-testid="backtests-panel"
      className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[30rem] flex-col"
    >
      <button
        data-testid="backtests-toggle"
        onClick={toggle}
        aria-expanded={open}
        className="ml-auto flex items-center gap-2 rounded-lg border border-border/50 bg-card px-3 py-2 text-sm shadow-card transition-colors hover:bg-surface-3"
      >
        <ListTree className="h-4 w-4 text-muted-foreground" />
        Backtests
        {runs.length > 0 && (
          <span className="tnum font-mono text-[10px] text-muted-foreground/70">{runs.length}</span>
        )}
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {open && (
        <div className="mt-2 min-h-0 space-y-4 overflow-y-auto rounded-xl border border-border/50 bg-card p-3 shadow-card">
          {groups.length === 0 ? (
            <p className="px-1 py-4 text-[11px] text-muted-foreground">
              Nothing run yet. Backtests started here land in this list.
            </p>
          ) : (
            // Said once, at the top, rather than in every column heading. All
            // three figures come from `excess_return_with_cost`, and repeating
            // the qualifier three times per row would crowd out the numbers.
            <p className="-mb-1 px-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">
              excess of benchmark · net of cost
            </p>
          )}

          {groups.map((group) => (
            <div key={group.key}>
              {/* The strategy's name, at a size you can read. It used to be a
                  10px mono uppercase line truncated to about six characters,
                  which is not a name — it is the shape of one. */}
              <div className="mb-1.5 flex items-baseline gap-2">
                <span
                  title={group.label}
                  className="min-w-0 flex-1 truncate text-[13px] font-medium"
                >
                  {group.label}
                </span>
                <span className="tnum shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  {group.runs.length} run{group.runs.length === 1 ? '' : 's'}
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

              {group.runs.map((run, i) => {
                const isLive = run.id === liveRunId
                return (
                  <RunRow
                    key={run.id}
                    // The streamed copy is fresher than the polled list.
                    run={isLive && live ? live : run}
                    // Numbered from the oldest, so a run keeps its number as
                    // newer ones arrive. The list is newest-first.
                    ordinal={group.runs.length - i}
                    report={reports[run.id]}
                    // The list is newest-first, so the *next* row is the attempt
                    // this one followed.
                    previous={group.runs[i + 1]}
                    expanded={!!expanded[run.id]}
                    onToggle={() => setExpanded((p) => ({ ...p, [run.id]: !p[run.id] }))}
                    onOpenReport={() => onOpenReport(run)}
                    onDelete={() => onDeleteRun(run)}
                    live={isLive ? { log, cancel, cancelling, stalled } : undefined}
                  />
                )
              })}
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

interface LiveProps {
  log: string[]
  cancel: () => void
  cancelling: boolean
  stalled: boolean
}

function RunRow({
  run, ordinal, report, previous, expanded, onToggle, onOpenReport, onDelete, live,
}: {
  run: Run
  /** Its place in the strategy's own history, oldest first. */
  ordinal: number
  report?: RunReport | null
  previous?: Run
  expanded: boolean
  onToggle: () => void
  onOpenReport: () => void
  onDelete: () => Promise<void>
  /** Present only on the one run this panel is streaming. */
  live?: LiveProps
}) {
  const [confirming, setConfirming] = useState(false)
  const done = run.status === 'succeeded'
  const active = isActive(run)
  const metrics = metricRow(run, report)
  const changed = changedSince(previous, run)

  // Inline two-click, matching the rail's own delete idiom: a run is a result,
  // not authored work, and the row is too dense for a dialog.
  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(t)
  }, [confirming])

  return (
    <div className="mb-1.5 overflow-hidden rounded-lg border border-border/50 bg-surface-2">
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        {/* Which attempt this was. The row used to lead with the universe
            truncated to about two characters, which named nothing. */}
        <div className="flex w-14 shrink-0 items-center gap-1.5">
          <RunStatusIcon status={run.status} />
          <span className="tnum text-[13px] font-medium">#{ordinal}</span>
        </div>

        {done ? (
          <>
            {/* Return first: the question everyone asks of a backtest is
                whether it made money, and a bare column of numbers with no
                headings does not answer any question at all. */}
            <Metric run={run} report={report} name="annualised" value={metrics.annualised} />
            <Metric run={run} report={report} name="ir" value={metrics.ir} />
            <Metric run={run} report={report} name="maxDrawdown" value={metrics.maxDrawdown} />
          </>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              {run.status}
            </div>
            <div className="truncate text-[13px] text-muted-foreground">
              {active ? run.phase : (run.universe ?? run.model ?? '—')}
            </div>
          </div>
        )}

        <button
          data-testid={`backtest-results-${run.id}`}
          disabled={!done}
          onClick={onOpenReport}
          className={cn(
            'shrink-0 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors',
            done
              ? 'border-primary/50 text-primary hover:bg-primary/10'
              : 'cursor-not-allowed border-transparent text-muted-foreground/40',
          )}
        >
          View
        </button>

        {/* Absent while the run can still write to its own directory: the
            server 409s, and offering an action that cannot work is worse than
            offering none. Cancel is the action there. */}
        {!active && (
          <button
            data-testid={`backtest-delete-${run.id}`}
            onClick={() => {
              if (!confirming) { setConfirming(true); return }
              setConfirming(false)
              void onDelete()
            }}
            onMouseLeave={() => setConfirming(false)}
            title={confirming ? 'Click again to delete' : 'Delete this run'}
            className={cn('shrink-0 transition-colors',
                          confirming ? 'text-clay' : 'text-muted-foreground/50 hover:text-foreground')}
          >
            {confirming
              ? <span className="font-mono text-[10px] uppercase tracking-wider">sure?</span>
              : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        )}

        <button
          onClick={onToggle}
          aria-expanded={expanded}
          title={expanded ? 'Hide details' : 'Show details'}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
        </button>
      </div>

      {expanded && (live && active
        ? <LiveBody run={run} live={live} />
        : <FinishedBody run={run} report={report} metrics={metrics} changed={changed} />)}
    </div>
  )
}

/** The streaming half. Fixed height so the panel cannot be pushed off screen. */
function LiveBody({ run, live }: { run: Run; live: LiveProps }) {
  return (
    <div className="border-t border-border/50">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Elapsed run={run} />
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {run.status === 'queued' ? 'waiting for the running backtest' : 'usually a few minutes'}
        </span>
        {live.stalled && (
          <span
            className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-clay"
            title="Lost the event stream; retrying. The backtest itself is unaffected."
          >
            reconnecting
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-6 shrink-0 px-2 text-[10px]"
          disabled={live.cancelling}
          onClick={live.cancel}
        >
          Cancel
        </Button>
      </div>
      {/* `overscroll-contain` so reaching the end of the log does not start
          scrolling the panel behind it. */}
      <RunLog lines={live.log} className="h-48 overscroll-contain px-3 pb-2" />
    </div>
  )
}

function FinishedBody({ run, report, metrics, changed }: {
  run: Run
  report?: RunReport | null
  metrics: ReturnType<typeof metricRow>
  changed: string | null
}) {
  return (
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
      <Detail label="Started" value={new Date(run.created_at).toLocaleString()} />

      {run.error_hint && (
        <p className="pt-1 font-sans text-[11px] leading-relaxed text-clay">{run.error_hint}</p>
      )}
      {run.error && (
        <details className="pt-1">
          <summary className="cursor-pointer text-muted-foreground/70">Traceback</summary>
          <p className="whitespace-pre-wrap pt-1 leading-relaxed text-clay">{run.error}</p>
        </details>
      )}
      <details className="pt-1">
        <summary className="cursor-pointer text-muted-foreground/70">Diagnostics</summary>
        <div className="space-y-1 pt-1">
          <Detail label="Experiment" value={run.experiment_name} />
          <Detail label="Recorder" value={report?.recorder_id ?? '—'} />
        </div>
      </details>

      <div className="pt-1">
        <Link
          to={`/runs/${run.id}`}
          className="inline-flex items-center gap-1 font-sans text-[11px] text-primary hover:underline"
        >
          Open on the Runs page
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  )
}

/**
 * Column headings.
 *
 * The reference this panel is modelled on shows Net Profit / PF / Win Rate.
 * None of those exist here and none can be invented: qlib's backtest is
 * cross-sectional and emits no per-trade fills, so there is no trade ledger to
 * compute a profit factor or a win rate from. These are the three honest
 * equivalents, all from `excess_return_with_cost`.
 */
const METRIC_HEAD: Record<MetricKey, string> = {
  annualised: 'Ann. return',
  ir: 'Info ratio',
  maxDrawdown: 'Max DD',
  volatility: 'Volatility',
}

const METRIC_LABEL: Record<MetricKey, string> = {
  ir: 'Information ratio, excess of benchmark and net of cost',
  annualised: 'Annualised excess return, net of cost',
  maxDrawdown: 'Maximum drawdown of the excess curve',
  volatility: 'Volatility of the excess curve',
}

/**
 * One metric cell: a heading over a number.
 *
 * The heading is the point. Three unlabelled figures in a row —
 * `0.94  27.7%  -43.5%` — are unreadable to anyone who has not memorised the
 * column order, which is nobody, including the person who wrote it.
 *
 * Fixed width, always. Reports arrive four at a time, and a ledger that
 * reflows as they trickle in is unreadable while it settles — so a pending
 * cell is `···` at exactly the width of the number that replaces it.
 */
function Metric({ run, report, name, value }: {
  run: Run
  report?: RunReport | null
  name: MetricKey
  value: number | null
}) {
  // `undefined` is "not fetched yet"; `null` is "fetched, and there was nothing
  // recorded". The hook caches the null deliberately, so it will not retry.
  const pending = report === undefined && run.status === 'succeeded'
  const tone = metricTone(name, value)

  const text = pending
    ? '···'
    : value === null
      ? '—'
      : name === 'ir'
        ? value.toFixed(2)
        : `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%`

  return (
    <div
      title={pending ? 'Loading results…' : value === null
        ? 'No results recorded for this run.' : METRIC_LABEL[name]}
      className="min-w-0 flex-1"
    >
      <div className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {METRIC_HEAD[name]}
      </div>
      <div
        className={cn(
          'tnum truncate font-mono text-[13px]',
          pending ? 'text-muted-foreground/40'
            : tone === 'positive' ? 'text-primary'
              : tone === 'negative' ? 'text-clay' : 'text-muted-foreground',
        )}
      >
        {text}
      </div>
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

/** Wall-clock time the run has been going, ticking only while it still can change. */
function Elapsed({ run }: { run: Run }) {
  const start = run.started_at ?? run.created_at
  const [now, setNow] = useState(() => Date.now())

  const running = isActive(run)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  const end = run.finished_at ? Date.parse(run.finished_at) : now
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000))
  if (!Number.isFinite(seconds)) return null

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return (
    <span className="tnum shrink-0 font-mono text-[10px] text-muted-foreground">{mm}:{ss}</span>
  )
}

/** Collapsed/expanded survives a reload, but a fresh run always opens the panel. */
export function useBacktestsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => window.localStorage.getItem(OPEN_KEY) !== '0')

  const setOpen = useCallback((next: boolean) => {
    window.localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    setOpenState(next)
  }, [])

  return [open, setOpen]
}
