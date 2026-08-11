import { X } from 'lucide-react'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { MacroSeriesChart, type SeriesMode } from '@/components/macro/MacroSeriesChart'
import { SeriesPicker } from '@/components/macro/SeriesPicker'
import { YieldCurveChart } from '@/components/macro/YieldCurveChart'
import type { MacroCurveResponse, MacroSeriesData, MacroSeriesResponse } from '@/lib/api'
import { MAX_SERIES, SERIES_STROKES } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

const RANGES = [
  { value: '1y', label: '1Y' }, { value: '3y', label: '3Y' },
  { value: '5y', label: '5Y' }, { value: '10y', label: '10Y' },
  { value: 'max', label: 'Max' },
] as const

const COMPARES = [
  { value: 'none', label: 'None' }, { value: '1y', label: '1Y ago' },
  { value: '3y', label: '3Y ago' },
] as const

/**
 * The Treasury curve and the multi-series chart.
 *
 * The chips are the legend. Recharts' own `<Legend>` is dropped: it costs
 * ~28px, wraps unpredictably at six series, and cannot carry a remove control
 * — while the chip row does all three and shows the same stroke swatch the
 * board row does.
 */
export function SeriesExplorer({
  registry, series, selected, onToggle, onClear, range, onRangeChange,
  mode, onModeChange, compare, onCompareChange, curve, loadingSeries, loadingCurve,
}: {
  registry: MacroSeriesResponse | null
  series: MacroSeriesData[]
  selected: string[]
  onToggle: (key: string) => void
  onClear: () => void
  range: string
  onRangeChange: (range: string) => void
  mode: SeriesMode
  onModeChange: (mode: SeriesMode) => void
  compare: string
  onCompareChange: (compare: string) => void
  curve: MacroCurveResponse | null
  loadingSeries: boolean
  loadingCurve: boolean
}) {
  const label = (key: string) =>
    series.find((s) => s.key === key)?.label
    ?? registry?.groups.flatMap((g) => g.series).find((s) => s.key === key)?.label
    ?? key

  return (
    <div className="grid gap-3 xl:grid-cols-[380px_minmax(0,1fr)]">
      <Panel
        title="Treasury curve"
        loading={loadingCurve}
        actions={
          <Segmented
            value={compare}
            options={COMPARES}
            onChange={onCompareChange}
            size="sm"
          />
        }
      >
        {curve ? <YieldCurveChart curve={curve} /> : <div className="h-56" />}
      </Panel>

      <Panel
        title="Series"
        loading={loadingSeries}
        actions={
          <div className="flex items-center gap-2">
            <Segmented value={range} options={RANGES} onChange={onRangeChange} size="sm" />
            <Segmented
              value={mode}
              options={[
                { value: 'level', label: 'Level' },
                { value: 'indexed', label: 'Indexed' },
                { value: 'zscore', label: 'Z' },
              ]}
              onChange={(m) => onModeChange(m as SeriesMode)}
              size="sm"
            />
          </div>
        }
      >
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {selected.map((key, i) => (
            <span
              key={key}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/50 py-0.5 pl-1.5 pr-1 text-[11px]"
            >
              <span
                className="h-3 w-0.5 rounded-full"
                style={{ background: SERIES_STROKES[i % MAX_SERIES].stroke }}
              />
              <span className="max-w-[12rem] truncate">{label(key)}</span>
              <button
                type="button"
                onClick={() => onToggle(key)}
                aria-label={`Remove ${label(key)}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <SeriesPicker registry={registry} selected={selected} onToggle={onToggle} />
          {selected.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className={cn('font-mono text-[10px] text-muted-foreground',
                'hover:text-foreground')}
            >
              clear
            </button>
          )}
        </div>
        <MacroSeriesChart series={series} mode={mode} />
      </Panel>
    </div>
  )
}
