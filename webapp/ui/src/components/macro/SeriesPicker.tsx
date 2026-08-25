import { useMemo, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { MicroLabel } from '@/components/ui/micro-label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { MacroSeriesResponse } from '@/lib/api'
import { MAX_SERIES } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

/**
 * Reach a series by name rather than by scanning the board.
 *
 * This is the one thing the deleted rail did that the cross-asset board
 * cannot — searching 31 series by label — kept behind a click instead of a
 * permanent 288px column.
 */
export function SeriesPicker({ registry, selected, onToggle }: {
  registry: MacroSeriesResponse | null
  selected: string[]
  onToggle: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (registry?.groups ?? [])
      .map((group) => ({
        ...group,
        series: group.series.filter(
          (s) => !needle
            || s.label.toLowerCase().includes(needle)
            || s.key.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.series.length)
  }, [registry, query])

  const full = selected.length >= MAX_SERIES

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-0.5 font-mono text-micro text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> add
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-border/50 p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search series"
              className="h-8 pl-8 text-xs"
              data-testid="macro-series-search"
            />
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {groups.length === 0 && (
            <p className="p-4 text-center text-xs text-muted-foreground">No matches.</p>
          )}
          {groups.map((group) => (
            <div key={group.group} className="border-b border-border/30 last:border-0">
              <MicroLabel as="div" className="px-3 py-1.5">
                {group.label}
              </MicroLabel>
              {group.series.map((series) => {
                const on = selected.includes(series.key)
                const disabled = !series.available || (!on && full)
                return (
                  <button
                    key={series.key}
                    type="button"
                    data-testid={`macro-series-${series.key}`}
                    aria-disabled={disabled}
                    title={!series.available
                      ? (series.reason ?? 'No data on disk')
                      : (!on && full)
                        ? `${MAX_SERIES} of ${MAX_SERIES} selected — deselect one first`
                        : series.note || series.label}
                    onClick={() => { if (!disabled) onToggle(series.key) }}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs',
                      disabled ? 'cursor-not-allowed opacity-40'
                        : 'hover:bg-foreground/[0.04]',
                      on && 'bg-foreground/[0.07]',
                    )}
                  >
                    <span className="min-w-0 truncate">{series.label}</span>
                    {on && <span className="font-mono text-micro text-primary">on</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
