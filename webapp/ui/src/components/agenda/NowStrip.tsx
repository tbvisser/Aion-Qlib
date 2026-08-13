import { type ComponentType, useEffect, useState } from 'react'
import { CalendarClock, Database, FlaskConical } from 'lucide-react'
import { Link } from 'react-router-dom'

import { JobProgress } from '@/components/JobProgress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { api, type ActivityItem, type ActivityKind } from '@/lib/api'
import { formatStopwatch } from '@/lib/runDuration'
import { RUN_PHASES, phaseIndex } from '@/lib/runPhases'
import { cn } from '@/lib/utils'

/**
 * In-flight work, pinned in the Agenda's aside.
 *
 * Running and queued items are not "on a day" — they are happening — so they
 * never enter the day groups and are deliberately unaffected by the type
 * filter: operational chrome, not feed content.
 *
 * Each item is a row on the same rhythm as an agenda row, not a card. It used
 * to be a tile with a 26px stopwatch and a progress ring beside it, which made
 * sense beside a row of equally loud KPI tiles; with those gone the ring only
 * repeated what the stage track already says, and in a 340px column three
 * display figures were the noisiest thing on a page about a calendar.
 */
export function NowStrip({ live, onChanged }: {
  live: ActivityItem[]
  onChanged: () => void
}) {
  // Nothing running is the normal state, and an empty "Now" panel would claim
  // a permanent third of the aside to say so.
  if (live.length === 0) return null

  return (
    <Panel
      title="Now"
      hint={live.length === 1 ? '1 in flight' : `${live.length} in flight`}
      flush
    >
      <div className="divide-y divide-border/30">
        {live.map((item) => (
          <LiveRow key={item.id} item={item} onChanged={onChanged} />
        ))}
      </div>
    </Panel>
  )
}

const KIND: Record<ActivityKind, {
  label: string
  Icon: ComponentType<{ className?: string }>
}> = {
  run: { label: 'Backtest', Icon: FlaskConical },
  ingest: { label: 'Data ingest', Icon: Database },
  macro_refresh: { label: 'Macro refresh', Icon: CalendarClock },
}

function LiveRow({ item, onChanged }: { item: ActivityItem; onChanged: () => void }) {
  const [cancelling, setCancelling] = useState(false)
  const running = item.status === 'running'
  const { label, Icon } = KIND[item.kind]

  // Runs sit in the queue with only `created_at` stamped; jobs stamp
  // `started_at` at enqueue. Either way this is "since it entered the system",
  // and the caption beside the clock says which of the two it is.
  const elapsed = useElapsed(item.started_at ?? item.created_at)

  const cancel = async () => {
    setCancelling(true)
    try {
      await api.cancelRun(item.source_id)
    } catch {
      /* the refresh below shows whatever actually happened */
    }
    onChanged()
    setCancelling(false)
  }

  return (
    <div className="relative space-y-1.5 px-3 py-2">
      {/* The live rail: the one edge-to-edge cue separating a row doing work
          from one waiting its turn, readable before any text is. */}
      {running && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-0.5 animate-subtle-pulse bg-primary/70"
        />
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon className={cn(
            'h-3.5 w-3.5 shrink-0',
            running ? 'text-primary' : 'text-muted-foreground/60',
          )} />
          <span className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {label}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {running
            ? <Badge variant="primary" className="animate-subtle-pulse">live</Badge>
            : <Badge variant="muted">queued</Badge>}
          {item.kind === 'run' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}
        </span>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        {item.kind === 'run' ? (
          <Link
            to={`/runs/${item.source_id}`}
            className="min-w-0 truncate text-[13px] font-medium transition-colors hover:text-primary"
          >
            {item.title}
          </Link>
        ) : (
          <span className="min-w-0 truncate text-[13px] font-medium">{item.title}</span>
        )}
        <span className="tnum shrink-0 font-mono text-[11px] text-muted-foreground">
          {elapsed === null ? '—' : formatStopwatch(elapsed)}
          <span className="ml-1 text-muted-foreground/60">
            {running ? 'elapsed' : 'waiting'}
          </span>
        </span>
      </div>

      {item.kind === 'run' ? (
        <StageTrack phase={item.phase} running={running} />
      ) : item.progress ? (
        <JobProgress
          stage={item.progress.stage}
          message={item.progress.message}
          done={item.progress.done}
          total={item.progress.total}
          running={running}
        />
      ) : (
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {item.phase ?? 'Queued'}
        </p>
      )}
    </div>
  )
}

/**
 * The five stages of a backtest as a segmented track.
 *
 * A single bar would need a percentage, and the runner has none to give — it
 * reports which stage it is in and nothing about how far through it is. Five
 * segments say exactly that much: the ones behind are done, the lit one is
 * where the run is, and the rest have not been reached. Before the first stage
 * (queued, starting) the whole track stays dark rather than filling a segment
 * on a guess.
 */
function StageTrack({ phase, running }: { phase: string | null; running: boolean }) {
  const current = phaseIndex(phase)

  return (
    <div className="space-y-1">
      <div className="flex gap-1" aria-hidden>
        {RUN_PHASES.map((stage, i) => (
          <span
            key={stage}
            className={cn(
              'h-1 flex-1 rounded-full transition-colors duration-500',
              current !== null && i < current && 'bg-primary/60',
              current === i && 'bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.6)]',
              current === i && running && 'animate-subtle-pulse',
              (current === null || i > current) && 'bg-muted',
            )}
          />
        ))}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {current === null ? (phase ?? 'Queued') : RUN_PHASES[current]}
        </span>
        {current !== null && (
          <span className="tnum shrink-0 font-mono text-[10px] text-muted-foreground/60">
            {current + 1}/{RUN_PHASES.length}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Milliseconds since `iso`, reticking every second.
 *
 * The activity feed polls on its own schedule, so a clock derived only from
 * the payload would jump in whole polls and sit frozen between them. Elapsed
 * time is the one thing on this row the browser can keep true without asking.
 */
function useElapsed(iso: string | null): number | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  if (!iso) return null
  const started = Date.parse(iso)
  return Number.isFinite(started) ? now - started : null
}
