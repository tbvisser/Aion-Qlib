import { useMemo, useState } from 'react'
import {
  Activity, Bot, ChevronDown, ChevronUp, Search, X,
} from 'lucide-react'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import type { SegmentedOption } from '@/components/ui/segmented'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { IndicatorsResponse, Run } from '@/lib/api'

import { OVERLAY_COLORS } from '@/hooks/useChartOverlays'

const MAX_INDICATORS = 5
const MAX_RUNS = 3

type Tab = 'indicators' | 'models'

const TABS: readonly SegmentedOption<Tab>[] = [
  { value: 'indicators', label: 'Indicators', icon: Activity },
  { value: 'models', label: 'Models', icon: Bot },
]

interface ChartOverlaysPanelProps {
  library: IndicatorsResponse | null
  libraryLoading: boolean
  groupedRuns: { modelId: string; label: string; runs: Run[] }[]
  runsLoading: boolean
  selectedIndicators: string[]
  selectedRuns: string[]
  onToggleIndicator: (name: string) => void
  onToggleRun: (runId: string) => void
  disabled?: boolean
}

export function ChartOverlaysPanel({
  library,
  libraryLoading,
  groupedRuns,
  runsLoading,
  selectedIndicators,
  selectedRuns,
  onToggleIndicator,
  onToggleRun,
  disabled,
}: ChartOverlaysPanelProps) {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<Tab>('indicators')
  const [query, setQuery] = useState('')

  const activeCount = selectedIndicators.length + selectedRuns.length

  const familyLabel = useMemo(() => {
    const map = new Map<string, string>()
    library?.families.forEach((f) => map.set(f.key, f.label))
    return map
  }, [library])

  const filteredIndicators = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (
      library?.indicators.filter((i) => {
        if (!needle) return true
        return (
          i.name.toLowerCase().includes(needle) ||
          i.group.toLowerCase().includes(needle) ||
          i.description.toLowerCase().includes(needle)
        )
      }) ?? []
    )
  }, [library, query])

  const groupedIndicators = useMemo(() => {
    const groups = new Map<string, typeof filteredIndicators>()
    filteredIndicators.forEach((i) => {
      if (!groups.has(i.family)) groups.set(i.family, [])
      groups.get(i.family)!.push(i)
    })
    return Array.from(groups.entries()).sort(
      (a, b) => (familyLabel.get(a[0]) ?? a[0]).localeCompare(familyLabel.get(b[0]) ?? b[0]),
    )
  }, [filteredIndicators, familyLabel])

  const collapseButton = (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:text-foreground"
      aria-label={open ? 'Collapse studies' : 'Expand studies'}
    >
      {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
    </button>
  )

  return (
    <Panel
      title="Studies"
      hint={activeCount > 0 ? `${activeCount} active` : undefined}
      loading={tab === 'indicators' ? libraryLoading : runsLoading}
      actions={
        <div className="flex items-center gap-2">
          {open && (
            <Segmented<Tab> size="sm" value={tab} options={TABS} onChange={setTab} />
          )}
          {collapseButton}
        </div>
      }
    >
      {!open && (
        <div className="flex flex-wrap items-center gap-2">
          {selectedIndicators.length === 0 && selectedRuns.length === 0 && (
            <span className="text-label text-muted-foreground/60">
              No overlays. Expand to add indicators or model signals.
            </span>
          )}
          {selectedIndicators.map((name, idx) => (
            <button
              key={name}
              type="button"
              onClick={() => onToggleIndicator(name)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-foreground/[0.02] px-2 py-1 text-label transition-colors hover:bg-foreground/[0.04]"
              title="Remove indicator"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: OVERLAY_COLORS[idx % OVERLAY_COLORS.length] }}
              />
              <span className="font-medium">{name}</span>
              <X className="h-3 w-3 text-muted-foreground/60" />
            </button>
          ))}
          {selectedRuns.map((runId) => {
            const run = groupedRuns.flatMap((g) => g.runs).find((r) => r.id === runId)
            return (
              <button
                key={runId}
                type="button"
                onClick={() => onToggleRun(runId)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-foreground/[0.02] px-2 py-1 text-label transition-colors hover:bg-foreground/[0.04]"
                title="Remove run"
              >
                <span className="font-medium">{run?.name ?? runId}</span>
                <X className="h-3 w-3 text-muted-foreground/60" />
              </button>
            )
          })}
        </div>
      )}

      {open && tab === 'indicators' && (
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search indicators…"
              className="h-8 pl-8 text-xs"
              disabled={disabled}
            />
          </div>

          {selectedIndicators.length >= MAX_INDICATORS && (
            <p className="text-label text-clay">
              Maximum {MAX_INDICATORS} indicators. Remove one to add another.
            </p>
          )}

          <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
            {groupedIndicators.map(([family, items]) => (
              <div key={family}>
                <div className="mb-1 font-mono text-micro uppercase tracking-wider text-muted-foreground/55">
                  {familyLabel.get(family) ?? family}
                </div>
                <div className="grid gap-1 sm:grid-cols-2">
                  {items.map((i) => {
                    const checked = selectedIndicators.includes(i.name)
                    const notRunnable = i.runnable === false
                    return (
                      <label
                        key={i.name}
                        title={i.note}
                        className={cn(
                          'flex cursor-pointer items-start gap-2 rounded-md p-1.5 transition-colors',
                          notRunnable || disabled
                            ? 'cursor-not-allowed opacity-50'
                            : 'hover:bg-foreground/[0.03]',
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => onToggleIndicator(i.name)}
                          disabled={notRunnable || disabled || (!checked && selectedIndicators.length >= MAX_INDICATORS)}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-label font-medium">{i.name}</span>
                            {i.in_handler && <Badge variant="primary">alpha158</Badge>}
                            {i.window != null && <Badge variant="outline">{i.window}d</Badge>}
                          </div>
                          <p className="text-micro leading-snug text-muted-foreground/70">
                            {i.description}
                          </p>
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
            {groupedIndicators.length === 0 && (
              <p className="text-label text-muted-foreground/50">No indicators match.</p>
            )}
          </div>
        </div>
      )}

      {open && tab === 'models' && (
        <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
          {selectedRuns.length >= MAX_RUNS && (
            <p className="text-label text-clay">
              Maximum {MAX_RUNS} runs. Remove one to add another.
            </p>
          )}

          {groupedRuns.length === 0 && (
            <p className="text-label text-muted-foreground/50">No finished runs yet.</p>
          )}
          {groupedRuns.map(({ modelId, label, runs }) => (
            <div key={modelId}>
              <div className="mb-1 font-mono text-micro uppercase tracking-wider text-muted-foreground/55">
                {label}
              </div>
              <div className="grid gap-1 sm:grid-cols-2">
                {runs.map((run) => {
                  const checked = selectedRuns.includes(run.id)
                  return (
                    <label
                      key={run.id}
                      className={cn(
                        'flex cursor-pointer items-start gap-2 rounded-md p-1.5 transition-colors',
                        disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-foreground/[0.03]',
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => onToggleRun(run.id)}
                        disabled={disabled || (!checked && selectedRuns.length >= MAX_RUNS)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-label font-medium">{run.name}</div>
                        <div className="text-micro text-muted-foreground/60">
                          {run.finished_at
                            ? new Date(run.finished_at).toLocaleDateString()
                            : '—'}
                          {' · '}
                          {run.universe ?? '—'}
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
