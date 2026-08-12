import { type ComponentType, useEffect, useState } from 'react'
import { CalendarClock, Database, FlaskConical } from 'lucide-react'
import { Link } from 'react-router-dom'

import { JobProgress } from '@/components/JobProgress'
import { Ring } from '@/components/inbox/TileVisuals'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { api, type ActivityItem, type ActivityKind } from '@/lib/api'
import { formatStopwatch } from '@/lib/runDuration'
import { RUN_PHASES, phaseIndex, stagesComplete } from '@/lib/runPhases'
import { cn } from '@/lib/utils'

/**
 * In-flight work, pinned above the agenda.
 *
 * Running and queued items are not "on a day" — they are happening — so they
 * never enter the day groups and are deliberately unaffected by the type
 * filter: operational chrome, not feed content.
 *
 * Each item wears the same tile shape as the KPI row below it — mono label,
 * one display figure, one glyph — because it is answering the same kind of
 * question. Here the figure is a stopwatch and the glyph is how much of the
 * run is behind it, which is the pair a waiting user actually watches.
 */
export function NowStrip({ live, onChanged }: {
  live: ActivityItem[]
  onChanged: () => void
}) {
  if (live.length === 0) return null
  return (
    <Panel title="Now" hint="Running and queued work">
      {/* A lone card goes full width: half a panel of card beside half a panel
          of nothing reads as a layout bug, not as breathing room. */}
      <div className={cn('grid gap-3', live.length > 1 && 'sm:grid-cols-2 xl:grid-cols-3')}>
        {live.map((item) => (
          <LiveCard key={item.id} item={item} onChanged={onChanged} />
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

function LiveCard({ item, onChanged }: { item: ActivityItem; onChanged: () => void }) {
  const [cancelling, setCancelling] = useState(false)
  const running = item.status === 'running'
  const { label, Icon } = KIND[item.kind]

  // Runs sit in the queue with only `created_at` stamped; jobs stamp
  // `started_at` at enqueue. Either way this is "since it entered the system",
  // and the caption under the clock says which of the two it is.
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
    <div className={cn(
      'group relative overflow-hidden rounded-xl border bg-card px-3.5 py-3 shadow-sm',
      'transition-shadow hover:shadow-card-hover',
      running ? 'border-primary/25' : 'border-border/50',
    )}>
      {/* The live rail: the one edge-to-edge cue that separates a card doing
          work from one waiting its turn, readable before any text is. */}
      {running && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[2px] animate-subtle-pulse bg-primary/70"
        />
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {label}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {running ? (
            <span className="animate-subtle-pulse rounded bg-primary/10 px-1 font-mono text-[9px] uppercase tracking-wider text-primary">
              live
            </span>
          ) : (
            <span className="rounded bg-foreground/[0.06] px-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              queued
            </span>
          )}
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
          <span className={cn(
            'flex h-5 w-5 items-center justify-center rounded',
            running ? 'bg-primary/10 text-primary' : 'bg-foreground/[0.06] text-muted-foreground',
          )}>
            <Icon className="h-3 w-3" />
          </span>
        </div>
      </div>

      {item.kind === 'run' ? (
        <Link
          to={`/runs/${item.source_id}`}
          className="mt-1.5 block truncate text-sm font-medium transition-colors hover:text-primary"
        >
          {item.title}
        </Link>
      ) : (
        <span className="mt-1.5 block truncate text-sm font-medium">{item.title}</span>
      )}

      {/* Figure left, glyph right — the KPI tiles' shape, so the two rows read
          as one instrument panel rather than two unrelated widgets. */}
      <div className="mt-2.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="tnum text-[26px] font-semibold leading-none">
            {elapsed === null ? '—' : formatStopwatch(elapsed)}
          </div>
          <div className="mt-1.5 truncate text-[11px] text-muted-foreground">
            {running ? 'elapsed' : 'waiting'}
          </div>
        </div>
        <div className="flex shrink-0 items-end">
          <ProgressRing item={item} />
        </div>
      </div>

      {item.kind === 'run' ? (
        <StageTrack phase={item.phase} running={running} />
      ) : item.progress ? (
        <div className="mt-3">
          <JobProgress
            stage={item.progress.stage}
            message={item.progress.message}
            done={item.progress.done}
            total={item.progress.total}
            running={running}
          />
        </div>
      ) : (
        <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {item.phase ?? 'Queued'}
        </p>
      )}
    </div>
  )
}

/**
 * How much of the work is behind it, as a part-of-whole ring.
 *
 * Runs count stages, because that is the only progress the runner reports;
 * jobs count their own items. Both fall back to an empty track rather than a
 * guess when there is no denominator yet.
 */
function ProgressRing({ item }: { item: ActivityItem }) {
  const running = item.status === 'running'
  const tone = running ? 'text-primary' : 'text-muted-foreground/40'

  if (item.kind === 'run') {
    return (
      <Ring
        value={stagesComplete(item.phase)}
        total={RUN_PHASES.length}
        className={tone}
      />
    )
  }
  return (
    <Ring
      value={item.progress?.done ?? 0}
      total={item.progress?.total ?? 0}
      className={tone}
    />
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
    <div className="mt-3 space-y-1.5">
      <div className="flex gap-1" aria-hidden>
        {RUN_PHASES.map((stage, i) => (
          <span
            key={stage}
            className={cn(
              'h-1.5 flex-1 rounded-full transition-colors duration-500',
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
 * time is the one thing on this card the browser can keep true without asking.
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
