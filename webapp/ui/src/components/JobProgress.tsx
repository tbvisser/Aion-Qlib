import { MicroLabel } from '@/components/ui/micro-label'
import { cn } from '@/lib/utils'

/**
 * The job progress bar: stage label, done/total, percentage fill, message.
 *
 * Extracted verbatim from RefreshDataDialog's JobPanel so the ingest dialog,
 * the Inbox's in-flight rows and the agenda's fetch flow all draw progress
 * the same way. An indeterminate stage (no total yet) pulses at a fixed 8%
 * rather than sitting dead; a failed job paints the bar destructive and full.
 */
export function JobProgress({
  stage, message, done, total, running, failed = false,
}: {
  stage: string | null
  message: string | null
  done: number | null
  total: number | null
  running: boolean
  failed?: boolean
}) {
  const pct = total ? Math.round(((done ?? 0) / total) * 100) : null

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <MicroLabel className="text-label">
          {stage ?? '—'}
        </MicroLabel>
        <span className="tnum font-mono text-xs text-muted-foreground">
          {total ? `${done ?? 0} / ${total}` : ''}
        </span>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            failed ? 'bg-destructive' : 'bg-primary',
            pct === null && running && 'animate-subtle-pulse',
            // A live bar glows faintly — reads as "in motion" at a glance.
            !failed && running && 'shadow-[0_0_8px_hsl(var(--primary)/0.5)]',
          )}
          style={{ width: running ? `${pct ?? 8}%` : '100%' }}
        />
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  )
}
