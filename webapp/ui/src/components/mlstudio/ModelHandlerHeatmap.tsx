import { useMemo } from 'react'
import { MicroLabel } from '@/components/ui/micro-label'
import type { Run, RunReport } from '@/lib/api'
import { metricRow } from '@/lib/runMetrics'
import { cn } from '@/lib/utils'

export function ModelHandlerHeatmap({
  runs, reports,
}: {
  runs: readonly Run[]
  reports: Record<string, RunReport | null>
}) {
  const { models, handlers, cells, maxAbs } = useMemo(() => {
    const modelSet = new Set<string>()
    const handlerSet = new Set<string>()
    const values: Record<string, number | null> = {}

    for (const run of runs) {
      const model = run.model ?? 'unknown'
      const handler = run.handler ?? 'unknown'
      modelSet.add(model)
      handlerSet.add(handler)
      const row = metricRow(run, reports[run.id] ?? null)
      const key = `${model}::${handler}`
      const ir = row.ir
      if (ir != null) {
        values[key] = values[key] == null ? ir : Math.max(values[key], ir)
      } else if (!(key in values)) {
        values[key] = null
      }
    }

    const models = Array.from(modelSet).sort()
    const handlers = Array.from(handlerSet).sort()
    const cells = models.map((model) =>
      handlers.map((handler) => ({
        model,
        handler,
        ir: values[`${model}::${handler}`] ?? null,
      })),
    )
    const maxAbs = Math.max(
      0.001,
      ...Object.values(values).filter((v): v is number => v != null).map(Math.abs),
    )

    return { models, handlers, cells, maxAbs }
  }, [runs, reports])

  if (!models.length || !handlers.length) {
    return (
      <div className="flex h-[200px] items-center justify-center text-xs text-muted-foreground">
        No model × feature-set combinations to heatmap yet.
      </div>
    )
  }

  const cellColor = (ir: number | null) => {
    if (ir == null) return 'hsl(var(--surface-2))'
    const t = Math.min(1, Math.abs(ir) / maxAbs)
    if (ir >= 0) {
      return `hsl(var(--primary) / ${0.08 + t * 0.72})`
    }
    return `hsl(var(--clay) / ${0.08 + t * 0.72})`
  }

  const textColor = (ir: number | null) => {
    if (ir == null) return 'text-muted-foreground'
    const t = Math.min(1, Math.abs(ir) / maxAbs)
    return t > 0.55 ? (ir >= 0 ? 'text-primary-foreground' : 'text-white')
      : 'text-foreground'
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[320px]">
        <div className="grid" style={{ gridTemplateColumns: `80px repeat(${handlers.length}, minmax(64px, 1fr))` }}>
          <div className="py-1" />
          {handlers.map((h) => (
            <MicroLabel as="div" key={h} className="px-1 py-1 text-center text-tiny">
              {h}
            </MicroLabel>
          ))}
          {cells.map((row, i) => (
            <div key={i} className="contents">
              <MicroLabel as="div" className="flex items-center py-1 pr-2 text-tiny">
                {models[i]}
              </MicroLabel>
              {row.map((cell, j) => (
                    <div key={j} className="p-0.5">
                  <div
                    className={cn(
                      'flex h-8 items-center justify-center rounded font-mono text-micro',
                      textColor(cell.ir),
                    )}
                    style={{ background: cellColor(cell.ir) }}
                    title={`${cell.model} × ${cell.handler}: ${cell.ir == null ? '—' : cell.ir.toFixed(3)}`}
                  >
                    {cell.ir == null ? '—' : cell.ir.toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
