/**
 * One node on the Keycard canvas.
 *
 * Rich, icon-forward card: a category-tinted icon tile, eyebrow label, bold
 * headline, detail chips, and a bottom accent bar. Connection handles are
 * clearly visible on the left/right edges.
 */
import { memo, useMemo, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  Box,
  Brain,
  Briefcase,
  CalendarClock,
  CalendarRange,
  CandlestickChart,
  Cpu,
  Database,
  DollarSign,
  FileText,
  Filter,
  Globe,
  Layers,
  ListFilter,
  Newspaper,
  Plus,
  Receipt,
  RotateCcw,
  Sigma,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  getValidChildren,
  isNodeConfigComplete,
  NODE_CATEGORY_INFO,
  nodeInfo,
  type NodeCategory,
} from '@/lib/keycardGraph/nodeRegistry'
import { cn } from '@/lib/utils'

import type { KeycardFlowNode } from '@/lib/keycardGraph/keycardFlow'

const ICONS: Record<string, LucideIcon> = {
  database: Database,
  globe: Globe,
  layers: Layers,
  brain: Brain,
  briefcase: Briefcase,
  'dollar-sign': DollarSign,
  'file-text': FileText,
  sigma: Sigma,
  cpu: Cpu,
  receipt: Receipt,
  'list-filter': ListFilter,
  'calendar-range': CalendarRange,
  'calendar-clock': CalendarClock,
  'candlestick-chart': CandlestickChart,
  filter: Filter,
  newspaper: Newspaper,
  plus: Plus,
  'rotate-ccw': RotateCcw,
  'trending-up': TrendingUp,
  box: Box,
}

function getIcon(iconName: string | null | undefined): LucideIcon {
  if (iconName && iconName in ICONS) return ICONS[iconName]
  return Box
}


function summarizeConfig(type: string, config: Record<string, unknown>): { headline: string; details: string[] } {
  const details: string[] = []
  switch (type) {
    case 'data_store':
      details.push(String(config.store ?? 'us'))
      break
    case 'universe':
      details.push(`${config.universe ?? 'top500'} · ${config.benchmark ?? 'SPY'}`)
      break
    case 'handler': {
      const feats = Array.isArray(config.features) ? config.features.length : 0
      const mode = String(config.feature_mode ?? 'extend')
      details.push(`${config.handler ?? 'Alpha158'}`)
      if (feats > 0) details.push(`${feats} custom ${feats === 1 ? 'factor' : 'factors'}`)
      else details.push(mode)
      break
    }
    case 'model':
      details.push(String(config.model ?? 'lightgbm'))
      break
    case 'portfolio':
      details.push(`Top ${config.topk ?? 50}`, `drop ${config.n_drop ?? 5}`)
      break
    case 'costs':
      details.push(`open ${config.open_cost ?? 0.0005}`, `close ${config.close_cost ?? 0.0015}`)
      break
    case 'records':
      details.push('Signal · SigAna · PortAna')
      break
    case 'run_per_candle':
    case 'run_at_time':
    case 'run_in_session':
      if (config.time) details.push(String(config.time))
      break
    case 'previous_day_bullish':
      details.push(config.lookback ? `${config.lookback}d lookback` : '1d lookback')
      break
    case 'candle_close_above_opening_range':
      details.push(`${config.minutes ?? 30}min ORB`)
      break
    case 'price_above_previous_day_close':
      details.push(config.confirm ? 'confirmed' : 'raw')
      break
    case 'news_filter':
      details.push(String(config.source ?? 'general'))
      break
    case 'buy_now':
      details.push(`${config.side ?? 'long'} · ${config.size ?? '100%'}`)
      break
    case 'trade_counter':
    case 'reset_trade_counter':
      details.push(`max ${config.max_trades ?? 3}`)
      break
    default:
      Object.entries(config)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .slice(0, 2)
        .forEach(([k, v]) => details.push(`${k}: ${String(v)}`))
  }
  const info = nodeInfo(type)
  return { headline: info?.label ?? type, details }
}

const GREY_COLOR = '#9ca3af'

export const KeycardNode = memo(function KeycardNode({ data, selected }: NodeProps<KeycardFlowNode>) {
  const { keycardNode, meta, defects } = data
  const info = nodeInfo(keycardNode.type)
  const eyebrow = info?.eyebrow ?? keycardNode.type
  const category = (meta?.category ?? info?.category ?? 'Data') as NodeCategory
  const categoryInfo = NODE_CATEGORY_INFO[category] ?? { color: GREY_COLOR, label: category }
  const Icon = getIcon(meta?.icon ?? info?.icon)

  const complete = useMemo(
    () => isNodeConfigComplete(keycardNode, meta ?? info),
    [keycardNode, meta, info],
  )
  const nodeColor = complete ? categoryInfo.color : GREY_COLOR

  const blocking = useMemo(() => defects.filter((d) => d.severity === 'blocking'), [defects])
  const advisory = useMemo(() => defects.filter((d) => d.severity === 'advisory'), [defects])

  const inputPorts = meta?.ports.filter((p) => p.direction === 'in') ?? []
  const outputPorts = meta?.ports.filter((p) => p.direction === 'out') ?? []
  const { headline, details } = summarizeConfig(keycardNode.type, keycardNode.config)
  const description = meta?.description ?? info?.description ?? ''

  const [openMenuPortId, setOpenMenuPortId] = useState<string | null>(null)

  return (
    <div
      style={{ width: 236 }}
      className={cn(
        'aion-keycard-node group relative flex cursor-pointer overflow-hidden rounded-xl',
        'border bg-card shadow-card transition-shadow hover:shadow-card-hover',
        blocking.length > 0 ? 'border-clay/50' : 'border-border/50',
        (selected || data.selected) && 'ring-2 ring-primary',
      )}
      onDoubleClick={() => data.onDoubleClick?.(keycardNode.id)}
      data-testid={`keycard-node-${keycardNode.id}`}
    >
      {/* Category accent along the bottom edge. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px]"
        style={{ backgroundColor: nodeColor }}
      />

      {/* Input handles */}
      {inputPorts.map((port, i) => {
        const count = inputPorts.length
        const top = count === 1 ? 46 : 18 + (i * 56) / Math.max(count - 1, 1)
        return (
          <Handle
            key={`in-${port.id}`}
            type="target"
            position={Position.Left}
            id={port.id}
            className="aion-keycard-handle"
            style={{
              top,
              left: -7,
              background: nodeColor,
              borderColor: nodeColor,
            }}
          />
        )
      })}

      {/* Output handles */}
      {outputPorts.map((port, i) => {
        const count = outputPorts.length
        const top = count === 1 ? 46 : 18 + (i * 56) / Math.max(count - 1, 1)
        const children = getValidChildren(port.type)
        return (
          <div key={`out-${port.id}`}>
            <Handle
              type="source"
              position={Position.Right}
              id={port.id}
              className="aion-keycard-handle"
              style={{
                top,
                right: -7,
                background: nodeColor,
                borderColor: nodeColor,
              }}
            />
            {children.length > 0 && data.onCreateNode && (
              <Popover open={openMenuPortId === port.id} onOpenChange={(open) => setOpenMenuPortId(open ? port.id : null)}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      'absolute z-10 flex h-4 w-4 items-center justify-center rounded-full',
                      'border border-border/50 bg-card text-muted-foreground shadow-sm',
                      'opacity-0 transition-opacity group-hover:opacity-100 hover:border-primary hover:text-primary',
                    )}
                    style={{ top: top - 6, right: -26 }}
                    title="Add connected block"
                  >
                    <Plus className="h-2.5 w-2.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  side="right"
                  sideOffset={8}
                  className="w-60 p-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Add next block
                  </div>
                  <ul className="max-h-60 space-y-0.5 overflow-y-auto">
                    {children.map((child) => {
                      const childInfo = nodeInfo(child.id)
                      const childCategory = (childInfo?.category ?? 'Data') as NodeCategory
                      const childCatInfo = NODE_CATEGORY_INFO[childCategory] ?? { color: '#9ca3af' }
                      const ChildIcon = getIcon(child.icon ?? childInfo?.icon)
                      return (
                        <li key={child.id}>
                          <button
                            type="button"
                            className="flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent"
                            onClick={() => {
                              data.onCreateNode?.(keycardNode.id, port.id, child.id)
                              setOpenMenuPortId(null)
                            }}
                          >
                            <span
                              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded"
                              style={{ background: `${childCatInfo.color}15`, color: childCatInfo.color }}
                            >
                              <ChildIcon className="h-3 w-3" />
                            </span>
                            <div className="min-w-0">
                              <div className="truncate text-[11px] font-medium">{child.label}</div>
                              <div className="line-clamp-2 text-[10px] text-muted-foreground/80">
                                {child.description}
                              </div>
                            </div>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </PopoverContent>
              </Popover>
            )}
          </div>
        )
      })}

      {/* Icon tile */}
      <span
        className="ml-2.5 mt-2.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: `${nodeColor}15`, color: nodeColor }}
      >
        <Icon className="h-4 w-4" />
      </span>

      {/* Content */}
      <div className="flex min-w-0 flex-1 flex-col justify-center px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="tnum shrink-0 font-mono text-[9px] uppercase tracking-wider"
            style={{ color: nodeColor }}
          >
            {keycardNode.type}
          </span>
          <span className="truncate font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
            · {eyebrow}
          </span>
        </div>

        <div title={headline} className="mt-0.5 min-w-0 truncate text-sm font-semibold leading-tight tracking-tight">
          {headline}
        </div>

        {description && (
          <p
            title={description}
            className="mt-0.5 line-clamp-2 min-w-0 text-[10px] leading-snug text-muted-foreground/80"
          >
            {description}
          </p>
        )}

        {details.length > 0 && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 overflow-hidden">
            {details.slice(0, 2).map((line, idx) => (
              <span
                key={idx}
                title={line}
                className="tnum max-w-full shrink-0 truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground/80"
              >
                {line}
              </span>
            ))}
          </div>
        )}

        {keycardNode.type === 'handler' && Array.isArray(keycardNode.config.features) && keycardNode.config.features.length > 0 && (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1 overflow-hidden">
            {(keycardNode.config.features as { name?: string }[]).slice(0, 3).map((f, idx) => (
              <span
                key={idx}
                title={f.name}
                className="tnum max-w-full shrink-0 truncate rounded bg-type-process/10 px-1.5 py-0.5 font-mono text-[9px] text-type-process"
              >
                {f.name ?? `F${idx + 1}`}
              </span>
            ))}
            {(keycardNode.config.features as { name?: string }[]).length > 3 && (
              <span className="tnum rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                +{(keycardNode.config.features as { name?: string }[]).length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Status badge */}
      {blocking.length > 0 && (
        <Badge variant="clay" className="mr-2.5 mt-2.5 shrink-0 truncate text-[9px]">
          {blocking.length}
        </Badge>
      )}
      {!blocking.length && advisory.length > 0 && (
        <Badge variant="muted" className="mr-2.5 mt-2.5 shrink-0 truncate text-[9px]">
          {advisory.length}
        </Badge>
      )}
      {!blocking.length && !complete && (
        <Badge variant="muted" className="mr-2.5 mt-2.5 shrink-0 truncate text-[9px]">
          Incomplete
        </Badge>
      )}

      {/* Category label in the corner */}
      <span
        className="pointer-events-none absolute bottom-2 right-2.5 font-mono text-[9px] uppercase tracking-wider opacity-40"
        style={{ color: nodeColor }}
      >
        {categoryInfo.label}
      </span>
    </div>
  )
})
