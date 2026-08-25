/**
 * Several attempts at one idea, side by side.
 *
 * The backtest ledger groups repeated runs of a strategy together, which makes
 * "which of these was best?" the obvious next question and was the one thing
 * nothing could answer: each report opened alone, and comparing meant
 * remembering four numbers while clicking through four modals.
 *
 * Capped at four runs. Past that, distinguishable hues stop existing in this
 * palette, and the honest answer is to make the reader deselect one rather than
 * to invent a fifth colour belonging to no token — the same cap, and the same
 * disabled-with-a-reason gesture, that `SeriesPicker` uses.
 */
import { useEffect, useState } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MicroLabel } from '@/components/ui/micro-label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useRunReports } from '@/hooks/useRunReports'
import type { Run } from '@/lib/api'
import { COMPARE_COLORS, decimate, mergeCurves } from '@/lib/curves'
import {
  best, formatRunPercent, metricRow, runDiff, type MetricKey,
} from '@/lib/runMetrics'
import { cn } from '@/lib/utils'

export const MAX_COMPARE = 4

const AXIS_TICK = {
  fontSize: 10, fontFamily: 'IBM Plex Mono', fill: 'hsl(var(--muted-foreground))',
}

const COLUMNS: { key: MetricKey; label: string; percent?: boolean; digits?: number }[] = [
  { key: 'ir', label: 'Info ratio', digits: 3 },
  { key: 'annualised', label: 'Ann. excess', percent: true },
  { key: 'maxDrawdown', label: 'Max drawdown', percent: true },
  { key: 'volatility', label: 'Volatility', digits: 4 },
]

export function RunCompareModal({ runs, open, onClose, title }: {
  /** Candidates — every succeeded run in the group. */
  runs: Run[]
  open: boolean
  onClose: () => void
  title?: string
}) {
  const [selected, setSelected] = useState<string[]>([])
  const { reports } = useRunReports(runs)

  /**
   * Seed the selection from whatever is actually on offer.
   *
   * A lazy `useState` initialiser is not enough: a caller that mounts this with
   * `open={false}` and fills `runs` later would run the initialiser against an
   * empty list once and never again — the modal then opens with nothing picked
   * and asks the reader to pick, having been handed the answer already.
   */
  useEffect(() => {
    if (!open) return
    setSelected((prev) => {
      const live = prev.filter((id) => runs.some((r) => r.id === id))
      return live.length ? live : runs.slice(0, 2).map((r) => r.id)
    })
  }, [open, runs])

  const chosen = runs.filter((r) => selected.includes(r.id))
  const rows = chosen.map((r) => metricRow(r, reports[r.id]))
  const full = selected.length >= MAX_COMPARE

  const toggle = (id: string) => setSelected((prev) =>
    prev.includes(id) ? prev.filter((x) => x !== id)
      : prev.length >= MAX_COMPARE ? prev : [...prev, id])

  // Merge first, decimate second. Thinning each series on its own produces
  // staggered date grids, and `mergeCurves` then fills the holes with `null` —
  // which Recharts draws as a break in every other line.
  const merged = mergeCurves(Object.fromEntries(chosen.map((r) => [
    r.id, reports[r.id]?.curves.excess ?? reports[r.id]?.curves.strategy,
  ])))
  const anchor = chosen[0]?.id
  const points = anchor
    ? decimate(merged, 600, (row) => (typeof row[anchor] === 'number' ? row[anchor] : null))
    : merged

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90vh] w-[min(96vw,72rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Compare runs{title ? ` · ${title}` : ''}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5" data-testid="compare-picker">
          {runs.map((run, i) => {
            const on = selected.includes(run.id)
            const disabled = !on && full
            return (
              <button
                key={run.id}
                type="button"
                data-testid={`compare-run-${run.id}`}
                // aria-disabled, not disabled: the title is the only place the
                // cap is explained, and a disabled button swallows hover.
                aria-disabled={disabled}
                title={disabled
                  ? `${MAX_COMPARE} of ${MAX_COMPARE} selected — deselect one first`
                  : new Date(run.created_at).toLocaleString()}
                onClick={() => { if (!disabled) toggle(run.id) }}
                className={cn(
                  'flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-label transition-colors',
                  on ? 'border-border bg-foreground/[0.06]' : 'border-border/50',
                  disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-foreground/[0.04]',
                )}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{
                    background: on
                      ? COMPARE_COLORS[selected.indexOf(run.id) % COMPARE_COLORS.length]
                      : 'hsl(var(--border))',
                  }}
                />
                {run.model ?? 'run'} #{runs.length - i}
              </button>
            )
          })}
        </div>

        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Pick at least one run.
          </p>
        ) : (
          <>
            <Table className="min-w-[32rem] text-sm">
              <TableHead>
                <tr>
                  <TableHeader>Metric</TableHeader>
                  {chosen.map((run, i) => (
                    <TableHeader key={run.id} numeric>
                      <span style={{ color: COMPARE_COLORS[i % COMPARE_COLORS.length] }}>
                        {run.model ?? 'run'} #{runs.length - runs.indexOf(run)}
                      </span>
                    </TableHeader>
                  ))}
                </tr>
              </TableHead>
              <TableBody>
                {COLUMNS.map((column) => {
                  const winner = best(rows, column.key)
                  return (
                    <TableRow key={column.key}>
                      <TableCell className="text-muted-foreground">{column.label}</TableCell>
                      {rows.map((row) => (
                        <TableCell key={row.runId} numeric className="text-xs">
                          {format(row[column.key], column)}
                          {/* `primary`, never `destructive`: a losing run is a
                              clay verdict, not an error, and `Badge` declines
                              to offer destructive for exactly that reason. */}
                          {winner === row.runId && rows.length > 1 && (
                            <Badge variant="primary" className="ml-1.5">best</Badge>
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>

            <div>
              <MicroLabel as="div" className="mb-1">
                Excess return, net of cost
              </MicroLabel>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={points} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                  <CartesianGrid stroke="hsl(var(--border) / 0.4)" vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={40}
                         tick={AXIS_TICK} />
                  <YAxis tickLine={false} axisLine={false} tick={AXIS_TICK}
                         tickFormatter={(v: number) => v.toFixed(2)} />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 8,
                      fontSize: 11,
                      fontFamily: 'IBM Plex Mono',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'IBM Plex Mono' }} />
                  {chosen.map((run, i) => (
                    <Line
                      key={run.id}
                      type="monotone"
                      dataKey={run.id}
                      name={`${run.model ?? 'run'} #${runs.length - runs.indexOf(run)}`}
                      stroke={COMPARE_COLORS[i % COMPARE_COLORS.length]}
                      dot={false}
                      strokeWidth={1.5}
                      connectNulls={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <Differences runs={chosen} />
          </>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** What was actually different, so a difference in outcome has a candidate cause. */
function Differences({ runs }: { runs: Run[] }) {
  const rows = runDiff(runs)
  if (runs.length < 2) return null

  return (
    <div>
      <MicroLabel as="div" className="mb-1">
        What differs
      </MicroLabel>
      {rows.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">
          Nothing recorded differs between these runs — same model, same universe, same
          settings. Any gap in the numbers is the engine's own variance, or a change made
          before run metadata recorded it.
        </p>
      ) : (
        <div className="space-y-1">
          {rows.map((row) => (
            <div key={row.field} className="flex items-baseline gap-3 text-xs">
              <MicroLabel className="w-28 shrink-0">
                {row.field}
              </MicroLabel>
              {runs.map((run) => (
                <span key={run.id} className="min-w-0 flex-1 truncate font-mono">
                  {row.values[run.id]}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function format(
  value: number | null, column: { percent?: boolean; digits?: number },
): string {
  if (value == null) return '—'
  // Clamped, so one broken run cannot blow the column width out for every run
  // it is being compared against. See `formatRunPercent`.
  return column.percent
    ? formatRunPercent(value, 1, false)
    : value.toFixed(column.digits ?? 2)
}
