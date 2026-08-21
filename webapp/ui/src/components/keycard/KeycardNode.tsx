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
  Search,
  Sigma,
  TrendingUp,
  X,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  getCompatibleInputPort,
  getRootNodeTypes,
  isNodeConfigComplete,
  NODE_CATEGORY_INFO,
  nodeInfo,
  type NodeCategory,
} from '@/lib/keycardGraph/nodeRegistry'
import { cn } from '@/lib/utils'
import type { KeycardNodeCategory, KeycardNodeTypeMeta, KeycardPortType } from '@/lib/api'

import type { KeycardFlowNode, KeycardAddNextData } from '@/lib/keycardGraph/keycardFlow'

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
  // Ephemeral add-next pseudo-node.
  if ('sourceNodeId' in data) {
    const addNextData = data as KeycardAddNextData
    return (
      <AddNextNodeView
        sourceNodeId={addNextData.sourceNodeId}
        sourcePortId={addNextData.sourcePortId}
        metaByType={addNextData.metaByType}
        onReplace={addNextData.onReplaceAddNext}
      />
    )
  }

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

  if (keycardNode.type === 'start') {
    return <StartNodeView metaByType={data.metaByType} onReplace={data.onReplaceStartNode} />
  }

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
            {data.onCreateNode && (
              <Popover open={openMenuPortId === port.id} onOpenChange={(open) => setOpenMenuPortId(open ? port.id : null)}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      'absolute z-10 flex h-4 w-4 items-center justify-center rounded-full',
                      'border border-border/50 bg-card text-muted-foreground shadow-sm',
                      'transition-colors hover:border-primary hover:text-primary',
                    )}
                    style={{ top: top - 6, right: -26 }}
                    title="Add block"
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
                  <AddNodeMenu
                    title="Add block"
                    metaByType={data.metaByType}
                    sourcePortType={port.type}
                    onSelect={(type) => {
                      data.onCreateNode?.(keycardNode.id, port.id, type)
                      setOpenMenuPortId(null)
                    }}
                  />
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

export function AddNodeMenu({
  metaByType,
  sourcePortType,
  allowedTypes,
  onSelect,
  title,
}: {
  metaByType: Map<string, KeycardNodeTypeMeta>
  sourcePortType?: KeycardPortType
  allowedTypes?: string[]
  onSelect: (type: string) => void
  title: string
}) {
  const [search, setSearch] = useState('')
  const allowed = useMemo(() => (allowedTypes ? new Set(allowedTypes) : null), [allowedTypes])

  const categories = useMemo(() => {
    const q = search.trim().toLowerCase()
    const byCat = new Map<string, KeycardNodeCategory>()
    for (const meta of metaByType.values()) {
      const catId = (meta.category ?? 'Other') as NodeCategory
      const cat = byCat.get(catId) ?? {
        id: catId,
        label: NODE_CATEGORY_INFO[catId]?.label ?? catId,
        items: [],
      }
      cat.items.push(meta)
      byCat.set(catId, cat)
    }
    return Array.from(byCat.values())
      .map((cat) => ({
        ...cat,
        items: cat.items.filter(
          (item) =>
            (!allowed || allowed.has(item.id)) &&
            (item.label.toLowerCase().includes(q) ||
              (item.description ?? '').toLowerCase().includes(q) ||
              item.id.toLowerCase().includes(q)),
        ),
      }))
      .filter((cat) => cat.items.length > 0)
  }, [search, allowed, metaByType])

  return (
    <div className="flex max-h-[70vh] w-60 flex-col">
      <div className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search blocks"
          className="h-7 pl-7 pr-7 text-xs"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
        {categories.map((category) => {
          const catInfo = NODE_CATEGORY_INFO[category.id as NodeCategory] ?? {
            id: category.id,
            label: category.label,
            icon: 'box',
            color: '#9ca3af',
          }
          const CatIcon = getIcon(catInfo.icon)
          return (
            <div key={category.id}>
              <div
                className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wider"
                style={{ color: catInfo.color }}
              >
                <CatIcon className="h-3 w-3" />
                {catInfo.label}
              </div>
              <ul className="space-y-0.5">
                {category.items.map((child) => {
                  const compatible = sourcePortType
                    ? getCompatibleInputPort(child.id, sourcePortType) !== undefined
                    : true
                  const ChildIcon = getIcon(child.icon ?? nodeInfo(child.id)?.icon)
                  return (
                    <li key={child.id}>
                      <button
                        type="button"
                        className={cn(
                          'flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent',
                          !compatible && 'opacity-60',
                        )}
                        onClick={() => onSelect(child.id)}
                      >
                        <span
                          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded"
                          style={{ background: `${catInfo.color}15`, color: catInfo.color }}
                        >
                          <ChildIcon className="h-3 w-3" />
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-[11px] font-medium">{child.label}</span>
                            {compatible && (
                              <span className="rounded bg-primary/10 px-1 py-0 text-[9px] text-primary">
                                fits
                              </span>
                            )}
                          </div>
                          <div className="line-clamp-2 text-[10px] text-muted-foreground/80">
                            {child.description}
                          </div>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StartNodeView({
  metaByType,
  onReplace,
}: {
  metaByType: Map<string, KeycardNodeTypeMeta>
  onReplace?: (type: string) => void
}) {
  const [open, setOpen] = useState(false)
  const allowedTypes = useMemo(() => getRootNodeTypes().map((info) => info.id), [])

  return (
    <div style={{ width: 236 }} data-testid="keycard-start-node">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'group flex w-full cursor-pointer flex-col items-center justify-center gap-2',
              'rounded-xl border border-dashed border-border/60 bg-card p-5 shadow-card',
              'transition-colors hover:border-primary/50 hover:bg-surface-2',
            )}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Plus className="h-5 w-5" />
            </span>
            <span className="text-sm font-medium">Add your first block</span>
            <span className="text-[11px] text-muted-foreground">Click to start building</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="center" side="right" sideOffset={12} className="w-60 p-2">
          <AddNodeMenu
            title="Start here"
            metaByType={metaByType}
            allowedTypes={allowedTypes}
            onSelect={(type) => {
              onReplace?.(type)
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function AddNextNodeView({
  sourceNodeId,
  sourcePortId,
  metaByType,
  onReplace,
}: {
  sourceNodeId: string
  sourcePortId: string
  metaByType: Map<string, KeycardNodeTypeMeta>
  onReplace?: (sourceNodeId: string, sourcePortId: string, type: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          data-testid={`keycard-add-next-${sourceNodeId}-${sourcePortId}`}
          className="relative flex h-11 w-11 cursor-pointer items-center justify-center rounded-full"
          onClick={(e) => e.stopPropagation()}
        >
          <Handle
            type="target"
            position={Position.Left}
            id="in"
            className="aion-keycard-handle-inert"
          />
          <span
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full',
              'border border-border/60 bg-card text-muted-foreground shadow-sm',
              'transition-colors hover:border-primary hover:text-primary hover:bg-surface-2',
            )}
            title="Add next block"
          >
            <Plus className="h-3.5 w-3.5" />
          </span>
        </div>
      </PopoverTrigger>
      <PopoverContent align="center" side="right" sideOffset={10} className="w-60 p-2">
        <AddNodeMenu
          title="Add next block"
          metaByType={metaByType}
          sourcePortType={sourcePortId as KeycardPortType}
          onSelect={(type) => {
            onReplace?.(sourceNodeId, sourcePortId, type)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
