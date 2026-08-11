import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { RunLog } from '@/components/runs/RunLog'
import { RunReportView } from '@/components/runs/RunReportView'
import { RunStatusIcon } from '@/components/runs/RunStatusIcon'
import { isActive, useRunStream } from '@/hooks/useRunStream'
import { type Run } from '@/lib/api'

const HEIGHT_KEY = 'aion.runDock.height'
const OPEN_KEY = 'aion.runDock.open'
const SESSION_KEY = 'aion.runDock.sessionRuns'
/** A third of the viewport: enough log to read, but the canvas stays the page. */
const DEFAULT_FRACTION = 0.34
const MIN_HEIGHT = 160
const MAX_HEIGHT = 560
/** Runs offered in the picker. The dock is a follow-along, not the archive. */
const PICKER_LIMIT = 8

type Tab = 'terminal' | 'results'

export interface RunDockProps {
  /** The page's shared run list, newest first. Also feeds `BacktestsPanel`. */
  runs: Run[]
  /** Saved strategy currently loaded, if any. Runs carry it as `strategy_id`. */
  strategyId?: string
  /** Runs launched from this builder session, newest first. */
  sessionRunIds: string[]
  /** The Run `startRun` just returned — shown before the stream has said anything. */
  seedRun: Run | null
  /** Refetch the page's shared run list once this run reaches a terminal status. */
  onFinish: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The backtest, followed from the builder.
 *
 * Pressing Run used to navigate to /runs/<id>, which threw away the canvas at
 * exactly the moment you wanted to keep it. This dock streams the same log and
 * the same report from the same hook, so the edit → run → read → tweak loop
 * never leaves the page. The Runs page remains the full-size archive.
 *
 * It used to carry a `History` dropdown as well. That was the only way to see
 * what had already been tried, and a dropdown is the wrong gesture for
 * something you consult while deciding what to change — `BacktestsPanel` is
 * that list now, always visible over the canvas. This is the live log alone.
 */
export function RunDock({
  runs, strategyId, sessionRunIds, seedRun, onFinish, open, onOpenChange,
}: RunDockProps) {
  const [runId, setRunId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('terminal')
  const [height, setHeight] = useState(readHeight)

  const { run, log, report, cancel, cancelling, stalled } = useRunStream(runId, onFinish, seedRun)

  // A newly started run takes over the dock, and opens it. A run restored from
  // sessionStorage after a reload is selected but must not override a dock the
  // user had deliberately collapsed.
  const latestSession = sessionRunIds[0]
  const restored = useRef(sessionRunIds[0])
  useEffect(() => {
    if (!latestSession) return
    setRunId(latestSession)
    setTab('terminal')
    if (latestSession !== restored.current) onOpenChange(true)
  }, [latestSession, onOpenChange])

  // Nothing started this session: fall back to this strategy's newest run so
  // reopening a saved strategy still shows how it last did.
  const newestForStrategy = useMemo(
    () => (strategyId ? runs.find((r) => r.strategy_id === strategyId) : undefined),
    [runs, strategyId],
  )
  useEffect(() => {
    if (runId || sessionRunIds.length > 0 || !newestForStrategy) return
    setRunId(newestForStrategy.id)
  }, [runId, sessionRunIds.length, newestForStrategy])

  // Results arrive late; surface them rather than leaving the terminal up.
  useEffect(() => { if (report) setTab('results') }, [report])
  useEffect(() => { if (!report && tab === 'results') setTab('terminal') }, [report, tab])

  // The dock does not close itself.
  //
  // It used to collapse the moment a run reached any terminal status, on the
  // theory that a finished run has no log left to follow. That got it exactly
  // backwards: the end of a backtest is the moment you have been waiting
  // several minutes for, and on a failure the log was the only place the reason
  // was written. It shut on both. The user opened this panel; they can close it.

  const resize = useResizeHandle(height, setHeight)

  const shown = run ?? (seedRun?.id === runId ? seedRun : null)
  // A builder that has never run anything shows no dock at all.
  if (!runId || !shown) return null

  const active = isActive(shown)

  return (
    <section
      data-testid="run-dock"
      className="flex shrink-0 flex-col border-t border-border/50 bg-card"
    >
      {open && (
        <div
          onPointerDown={resize}
          className="h-1 shrink-0 cursor-row-resize transition-colors hover:bg-primary/40"
        />
      )}

      <div className="flex shrink-0 items-center gap-3 px-3 py-2">
        <button
          data-testid="run-dock-toggle"
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          title={open ? 'Collapse the run panel' : 'Expand the run panel'}
        >
          <RunStatusIcon status={shown.status} />
          <span className="truncate text-sm">{shown.name}</span>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {shown.phase}
          </span>
          <Elapsed run={shown} />
        </button>

        {/* A backtest takes minutes. Saying so is the difference between
            "working" and "hung" for someone watching a stopwatch. */}
        {active && (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {shown.status === 'queued' ? 'waiting' : 'usually a few minutes'}
          </span>
        )}

        {stalled && (
          <span
            className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-clay"
            title="Lost the event stream; retrying. The backtest itself is unaffected."
          >
            reconnecting
          </span>
        )}

        {shown.status === 'failed' && (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-destructive">
            failed{shown.exit_code != null && ` · exit ${shown.exit_code}`}
          </span>
        )}

        {active && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={cancelling}
            onClick={cancel}
          >
            Cancel
          </Button>
        )}

        <Button variant="ghost" size="icon" asChild className="shrink-0">
          <Link to={`/runs/${shown.id}`} title="Open this run on the Runs page">
            <ExternalLink className="h-4 w-4" />
          </Link>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={() => onOpenChange(!open)}
          title={open ? 'Collapse the run panel' : 'Expand the run panel'}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </Button>
      </div>

      {open && (
        <div className="flex min-h-0 flex-col" style={{ height }}>
          <div className="flex shrink-0 items-center gap-1 border-t border-border/50 px-3 py-1.5">
            <Segmented
              value={tab}
              onChange={setTab}
              size="sm"
              options={[
                { value: 'terminal', label: 'Terminal', testId: 'run-dock-tab-terminal' },
                { value: 'results', label: 'Results', testId: 'run-dock-tab-results',
                  disabled: !report,
                  title: report ? undefined : 'Available once the run succeeds' },
              ]}
            />
          </div>

          {/* The reason, above the log rather than buried in its last 25 lines.
              `error_hint` is a sentence for the failures the backend knows by
              name; the traceback stays underneath for the ones it does not. */}
          {shown.status === 'failed' && (shown.error_hint || shown.error) && (
            <div className="shrink-0 border-t border-clay/30 bg-clay/[0.06] px-3 py-2">
              <p className="text-[11px] leading-relaxed text-clay">
                {shown.error_hint ?? 'The run failed. The log below ends with the reason.'}
              </p>
              {shown.error_hint && shown.error && (
                <details className="mt-1">
                  <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground">
                    Traceback
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground">
                    {shown.error}
                  </pre>
                </details>
              )}
            </div>
          )}

          {tab === 'terminal' ? (
            <RunLog lines={log} className="min-h-0 flex-1 px-3 pb-3" />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {report && <RunReportView report={report} compact />}
            </div>
          )}
        </div>
      )}
    </section>
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
    <span className="tnum shrink-0 font-mono text-[10px] text-muted-foreground">
      {mm}:{ss}
    </span>
  )
}

function readHeight(): number {
  const raw = Number(window.localStorage.getItem(HEIGHT_KEY))
  if (Number.isFinite(raw) && raw >= MIN_HEIGHT) return Math.min(raw, MAX_HEIGHT)
  return clampHeight(window.innerHeight * DEFAULT_FRACTION)
}

function clampHeight(px: number): number {
  return Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, px)))
}

/** Drag the top border to resize; the chosen height outlives the session. */
function useResizeHandle(height: number, setHeight: (h: number) => void) {
  const heightRef = useRef(height)
  heightRef.current = height

  return useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = heightRef.current

    // Dragging up grows the dock, hence the inverted delta.
    const move = (ev: PointerEvent) => setHeight(clampHeight(startHeight + (startY - ev.clientY)))
    const up = () => {
      window.localStorage.setItem(HEIGHT_KEY, String(heightRef.current))
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [setHeight])
}

/** Collapsed/expanded survives a reload, but a fresh run always opens the dock. */
export function useRunDockOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => window.localStorage.getItem(OPEN_KEY) !== '0')

  const setOpen = useCallback((next: boolean) => {
    window.localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    setOpenState(next)
  }, [])

  return [open, setOpen]
}

/**
 * Run ids launched from this tab, newest first.
 *
 * Kept in sessionStorage so a reload mid-backtest still lands on the running
 * run instead of an empty dock — but scoped to the tab, so it does not leak
 * into a second builder window.
 */
export function useSessionRuns() {
  const [ids, setIds] = useState<string[]>(readSessionRuns)
  const [seed, setSeed] = useState<Run | null>(null)

  const add = useCallback((run: Run) => {
    setSeed(run)
    setIds((prev) => {
      const next = [run.id, ...prev.filter((id) => id !== run.id)].slice(0, PICKER_LIMIT)
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  return useMemo(() => ({ ids, seed, add }), [ids, seed, add])
}

function readSessionRuns(): string[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}
