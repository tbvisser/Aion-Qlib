import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Table, TableBody } from '@/components/ui/table'
import { Sparkline } from '@/components/Sparkline'
import type { BoardGroup, Horizon } from '@/lib/macroBoard'
import {
  MAX_SERIES, SERIES_STROKES, formatChange, formatLevel, toneFor, zMark,
} from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

const HORIZONS = [
  { value: '1d', label: '1D' }, { value: '1w', label: '1W' },
  { value: '1m', label: '1M' }, { value: '1y', label: '1Y' },
] as const

/**
 * Where the market is, and the page's series picker.
 *
 * This replaces both the left rail and the tinted snapshot strip, which
 * carried the same 31 series twice. One row per series, once: label, sparkline,
 * level, change — and clicking it charts the series below.
 *
 * The z-score is a **discrete mark on the leading edge**, not a background
 * wash. The strip tinted all 31 tiles on a continuous scale, and marking
 * everything marks nothing; here three or four rows carry a mark and the rest
 * are quiet.
 */
export function CrossAssetBoard({
  groups, horizon, onHorizonChange, selected, onToggle, onClear, loading,
}: {
  groups: BoardGroup[]
  horizon: Horizon
  onHorizonChange: (h: Horizon) => void
  /** Ordered, because the position is the stroke index. */
  selected: string[]
  onToggle: (key: string) => void
  onClear: () => void
  loading: boolean
}) {
  const full = selected.length >= MAX_SERIES

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={horizon}
          options={HORIZONS}
          onChange={(h) => onHorizonChange(h as Horizon)}
          size="sm"
        />
        <div className="flex items-center gap-3">
          <span className="font-mono text-micro text-muted-foreground">
            {selected.length} of {MAX_SERIES} charted
          </span>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="font-mono text-micro text-muted-foreground hover:text-foreground"
            >
              clear
            </button>
          )}
        </div>
      </div>

      <div className={cn('grid gap-3 md:grid-cols-2 xl:grid-cols-3',
        loading && 'animate-subtle-pulse')}>
        {groups.map((group) => (
          <Panel key={group.id} title={group.label} flush>
            <Table>
              <TableBody>
                {group.rows.map((row) => {
                  const at = selected.indexOf(row.key)
                  const on = at >= 0
                  const mark = zMark(row.zscore)
                  const blocked = !on && full
                  const disabled = !row.available || blocked
                  return (
                    <tr
                      key={row.key}
                      data-testid={`macro-board-row-${row.key}`}
                      aria-disabled={disabled}
                      title={
                        !row.available ? (row.reason ?? 'No data on disk')
                          : blocked ? `${MAX_SERIES} of ${MAX_SERIES} selected — deselect one to add another`
                          : [row.note, mark && `${row.zscore?.toFixed(1)}σ from its own history`]
                              .filter(Boolean).join(' · ') || row.label
                      }
                      onClick={() => { if (!disabled) onToggle(row.key) }}
                      className={cn(
                        'border-b border-border/30 last:border-0',
                        disabled
                          // aria-disabled, not disabled: a disabled control
                          // swallows pointer events and eats the tooltip that
                          // carries the only explanation.
                          ? 'cursor-not-allowed opacity-40'
                          : 'cursor-pointer hover:bg-foreground/[0.04]',
                        on && 'bg-foreground/[0.07]',
                      )}
                    >
                      <td className="w-1 py-1.5 pl-2">
                        <span
                          className={cn('block h-4 w-0.5 rounded-full',
                            !on && mark && (mark.sign > 0
                              ? mark.level === 'extreme' ? 'bg-primary/80' : 'bg-primary/40'
                              : mark.level === 'extreme' ? 'bg-clay/80' : 'bg-clay/40'),
                            !on && !mark && 'bg-transparent')}
                          style={on
                            ? { background: SERIES_STROKES[at % MAX_SERIES].stroke }
                            : undefined}
                        />
                      </td>
                      <td className="min-w-0 py-1.5 pl-2 pr-2">
                        <span className="block truncate text-label">{row.label}</span>
                      </td>
                      <td className="w-[76px] py-1.5">
                        {row.spark.length > 1
                          ? <Sparkline values={row.spark} width={72} height={18} />
                          : null}
                      </td>
                      <td className="tnum w-[64px] py-1.5 pr-2 text-right font-mono text-label">
                        {row.available ? formatLevel(row.level, row.unit) : 'n/a'}
                      </td>
                      <td className={cn(
                        'tnum w-[62px] py-1.5 pr-2 text-right font-mono text-label',
                        toneFor(row.change),
                      )}>
                        {row.available ? formatChange(row.change, row.changeUnit) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </TableBody>
            </Table>
          </Panel>
        ))}
      </div>

      <p className="font-mono text-micro text-muted-foreground/70">
        A mark on the leading edge means the level is more than 1.5σ from its own
        history — direction against precedent, not desirability.
      </p>
    </div>
  )
}
