import { Panel } from '@/components/ui/panel'
import { MicroLabel } from '@/components/ui/micro-label'
import type { SummaryRow } from '@/lib/agendaSummary'

/**
 * The Agenda's summary, as a quiet label→value list.
 *
 * This replaces a row of four display tiles carrying gauge arcs, rings and
 * area curves. Every number survived; the decoration did not. On a page whose
 * subject is a calendar, four 26px figures with their own charts read louder
 * than the thing they summarise — and a ring showing "3 of 5 books" is a
 * slower way to read "3 of 5 books".
 *
 * `MetricTile` is the house primitive for a number with a label, but it stacks
 * label above value for a grid cell. This is a dense right-hand column, so the
 * rows are label-left / value-right instead.
 */
export function AtAGlance({ rows }: { rows: SummaryRow[] }) {
  return (
    <Panel title="At a glance" flush>
      <dl className="divide-y divide-border/30">
        {rows.map((row) => (
          <div key={row.label} className="px-3 py-2">
            <div className="flex items-baseline justify-between gap-3">
              <MicroLabel as="dt" className="min-w-0 truncate">
                {row.label}
              </MicroLabel>
              {/* tnum, unlike the display tiles this replaces: these values sit
                  in a column and have to align down it. Nothing else shares the
                  line — a qualifier between the label and the number puts a
                  word where the eye is looking for the figure. */}
              <dd className="tnum shrink-0 font-mono text-sm">{row.value}</dd>
            </div>
            {(row.sub || row.footnote) && (
              <p className="mt-0.5 text-micro text-muted-foreground/60">
                {[row.sub, row.footnote].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
        ))}
      </dl>
    </Panel>
  )
}
