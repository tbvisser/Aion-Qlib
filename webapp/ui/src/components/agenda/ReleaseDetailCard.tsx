import { ImportanceBadge } from '@/components/agenda/ImportanceBadge'
import { ReleaseHistoryChart } from '@/components/agenda/ReleaseHistoryChart'
import { useReleaseHistory } from '@/hooks/useReleaseHistory'
import type { MacroRelease } from '@/lib/api'
import { cn } from '@/lib/utils'

const num = (v: number | null) => (v == null ? '—' : String(v))

/**
 * One release, desk-style: the print's figures with the row's exact honesty
 * rules (surprise only when the backend filled it, "awaiting" never 0), and
 * the indicator's trailing prints as a chart underneath.
 *
 * Renders as a bare block, not a card. `EntryList` opens it inside the row's
 * own sub-panel, and a card nested in that would be a border inside a border
 * inside a panel.
 */
export function ReleaseDetailCard({ release, today }: {
  release: MacroRelease
  today: string
}) {
  const history = useReleaseHistory(release.event_key, release.country)
  const awaiting = release.actual == null && release.date < today
  const surpriseTone = release.surprise != null
    ? release.surprise > 0 ? 'text-primary'
      : release.surprise < 0 ? 'text-clay' : 'text-muted-foreground'
    : null

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <h4 className="min-w-0 truncate text-sm font-medium">{release.type ?? 'Release'}</h4>
          <ImportanceBadge tier={release.importance} />
        </div>
        <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {[release.country, release.comparison, release.period, release.time && `${release.time.slice(0, 5)}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 font-mono">
        <Figure label="act">
          {release.actual != null ? (
            <span className={cn('tnum text-base', surpriseTone)}>{num(release.actual)}</span>
          ) : (
            <span className="text-sm text-muted-foreground/60">
              {awaiting ? 'awaiting' : 'due'}
            </span>
          )}
        </Figure>
        <Figure label="est">
          <span className="tnum text-base text-muted-foreground">{num(release.estimate)}</span>
        </Figure>
        <Figure label="prev">
          <span className="tnum text-base text-muted-foreground/70">{num(release.previous)}</span>
        </Figure>
        {release.surprise != null && (
          <Figure label="surprise">
            <span className={cn('tnum text-base', surpriseTone)}>
              {release.surprise > 0 ? '+' : ''}{num(release.surprise)}
            </span>
          </Figure>
        )}
        {release.change_percentage != null && (
          <Figure label="Δ%">
            <span className="tnum text-sm text-muted-foreground">
              {num(release.change_percentage)}%
            </span>
          </Figure>
        )}
      </div>

      <div className="border-t border-border/40 pt-3">
        {release.event_key === null ? (
          <p className="text-[11px] text-muted-foreground/60">
            No history available for this release type.
          </p>
        ) : history.loading ? (
          <div className="h-[180px] animate-pulse rounded-md bg-foreground/[0.04]" />
        ) : history.data?.available && history.data.points.length > 0 ? (
          <>
            <ReleaseHistoryChart points={history.data.points} selectedDate={release.date} />
            <p className="mt-1 font-mono text-[10px] text-muted-foreground/50">
              last {history.data.points.filter((p) => p.actual != null).length} prints
              {release.country ? ` · ${release.country}` : ''}
            </p>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground/60">
            {history.error ? 'History could not be loaded.' : 'No history cached for this indicator.'}
          </p>
        )}
      </div>
    </div>
  )
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">{label}</span>
      {children}
    </span>
  )
}
