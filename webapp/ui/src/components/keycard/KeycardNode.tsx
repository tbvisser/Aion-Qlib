/**
 * One node on the Keycard canvas.
 *
 * n8n-style compact workflow node: a category-coloured icon strip on the left,
 * a bold title and a muted subtitle on the right, and small centred handles on
 * the left/right edges. The whole card is small enough to read as a horizontal
 * pipeline rather than a vertical form.
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
  GitBranch,
  Globe,
  Layers,
  ListFilter,
  MessageSquare,
  Newspaper,
  Plus,
  Receipt,
  RotateCcw,
  Search,
  Sigma,
  TrendingUp,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react'

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

import { inputPortHandleTop, outputPortHandleTop, PORT_COLORS, type KeycardFlowNode } from '@/lib/keycardGraph/keycardFlow'

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
  'git-branch': GitBranch,
  newspaper: Newspaper,
  plus: Plus,
  'rotate-ccw': RotateCcw,
  'trending-up': TrendingUp,
  'message-square': MessageSquare,
  box: Box,
  zap: Zap,
}

function getIcon(iconName: string | null | undefined): LucideIcon {
  if (iconName && iconName in ICONS) return ICONS[iconName]
  return Box
}

/** Compact n8n-style subtitle derived from the node's config. */
function summarizeConfig(type: string, config: Record<string, unknown>): { title: string; subtitle: string } {
  const info = nodeInfo(type)
  const title = info?.label ?? type
  let subtitle = ''
  switch (type) {
    case 'data_store':
      subtitle = String(config.store ?? 'us')
      break
    case 'universe':
      subtitle = `${config.universe ?? 'top500'} · ${config.benchmark ?? 'SPY'}`
      break
    case 'handler': {
      const feats = Array.isArray(config.features) ? config.features.length : 0
      subtitle = `${config.handler ?? 'Alpha158'}${feats > 0 ? ` · ${feats} factor${feats === 1 ? '' : 's'}` : ''}`
      break
    }
    case 'model':
      subtitle = String(config.model ?? 'lightgbm')
      break
    case 'portfolio':
      subtitle = `Top ${config.topk ?? 50} · drop ${config.n_drop ?? 5}`
      break
    case 'costs':
      subtitle = `open ${config.open_cost ?? 0.0005} · close ${config.close_cost ?? 0.0015}`
      break
    case 'records':
      subtitle = 'Signal · SigAna · PortAna'
      break
    case 'run_per_candle':
      subtitle = String(config.timeframe ?? '1d')
      break
    case 'run_at_time':
      subtitle = String(config.time ?? '09:30')
      break
    case 'run_in_session':
      subtitle = String(config.session ?? 'regular')
      break
    case 'previous_day_bullish':
      subtitle = `${config.lookback ?? 1}d lookback`
      break
    case 'candle_close_above_opening_range':
      subtitle = `${config.minutes ?? 30}min ORB`
      break
    case 'price_above_previous_day_close':
      subtitle = config.confirm ? 'confirmed' : 'raw'
      break
    case 'news_filter':
      subtitle = `${config.source ?? 'general'}${config.sentiment ? ` · ${config.sentiment}` : ''}`
      break
    case 'buy_now':
      subtitle = `${config.side ?? 'long'} · ${config.size ?? '100%'}`
      break
    case 'context': {
      const text = String(config.text ?? '').trim()
      subtitle = text || 'No objective set'
      break
    }
    case 'trade_rule':
    case 'branch':
      subtitle = String(config.condition ?? 'close > open')
      break
    case 'check_spread':
      subtitle = `${config.max_spread_bps ?? 10} bps`
      break
    case 'no_trade_for_day':
      subtitle = String(config.reason ?? 'stop-loss hit')
      break
    case 'trade_counter':
    case 'reset_trade_counter':
      subtitle = `max ${config.max_trades ?? 3}`
      break
    case 'variable':
      subtitle = `${config.name ?? 'var1'} = ${config.value ?? '0'}`
      break
    case 'chart_drawing':
      subtitle = `${config.type ?? 'level'} · ${config.price ?? 0}`
      break
    default: {
      const first = Object.entries(config)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .slice(0, 1)[0]
      subtitle = first ? `${first[0]}: ${String(first[1])}` : (info?.description ?? '')
    }
  }
  return { title, subtitle }
}

const GREY_COLOR = '#9ca3af'

/** n8n node dimensions. Keep in sync with keycardFlow.ts. */
const NODE_WIDTH = 160
const NODE_HEIGHT = 56

export const KeycardNode = memo(function KeycardNode({ data, selected }: NodeProps<KeycardFlowNode>) {
  const { keycardNode, meta, defects } = data
  const info = nodeInfo(keycardNode.type)
  const category = (meta?.category ?? info?.category ?? 'Data') as NodeCategory
  const categoryInfo = NODE_CATEGORY_INFO[category] ?? { color: GREY_COLOR, label: category }
  const Icon = getIcon(meta?.icon ?? info?.icon)

  const complete = useMemo(
    () => isNodeConfigComplete(keycardNode, meta ?? info),
    [keycardNode, meta, info],
  )
  const nodeColor = complete ? categoryInfo.color : GREY_COLOR

  const blocking = useMemo(() => defects.filter((d) => d.severity === 'blocking'), [defects])

  const inputPorts = meta?.ports.filter((p) => p.direction === 'in') ?? []
  const outputPorts = meta?.ports.filter((p) => p.direction === 'out') ?? []
  const { title, subtitle } = summarizeConfig(keycardNode.type, keycardNode.config)

  const [openMenuPortId, setOpenMenuPortId] = useState<string | null>(null)

  if (keycardNode.type === 'start') {
    return <StartNodeView metaByType={data.metaByType} onReplace={data.onReplaceStartNode} />
  }

  return (
    <div
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        'aion-keycard-node group relative flex cursor-pointer overflow-hidden rounded-lg',
        'border bg-card shadow-sm transition-shadow hover:shadow-md',
        blocking.length > 0 ? 'border-clay/60' : 'border-border/60',
        (selected || data.selected) && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
      )}
      onDoubleClick={() => data.onDoubleClick?.(keycardNode.id)}
      data-testid={`keycard-node-${keycardNode.id}`}
    >
      {/* Coloured icon strip — n8n places the brand icon on a solid left tile. */}
      <span
        className="flex w-11 shrink-0 items-center justify-center"
        style={{ backgroundColor: nodeColor }}
      >
        <Icon className="h-4 w-4 text-white" />
      </span>

      {/* Title + subtitle */}
      <div className="flex min-w-0 flex-1 flex-col justify-center px-2.5 py-1">
        <div
          title={title}
          className="min-w-0 truncate text-xs font-semibold leading-tight text-foreground"
        >
          {title}
        </div>
        {subtitle && (
          <div
            title={subtitle}
            className="min-w-0 truncate text-[10px] leading-snug text-muted-foreground"
          >
            {subtitle}
          </div>
        )}
      </div>

      {/* Status dot */}
      {blocking.length > 0 && (
        <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-destructive" />
      )}
      {!complete && blocking.length === 0 && (
        <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
      )}

      {/* Input handles */}
      {inputPorts.map((port) => {
        const top = inputPortHandleTop(meta, port.id)
        const portColor = PORT_COLORS[port.type] ?? nodeColor
        const active = data.connectingPortType != null && data.seekingHandle === 'target'
        const isCompatible = active && port.type === data.connectingPortType
        const isIncompatible = active && !isCompatible
        const isInactiveDirection = data.connectingPortType != null && data.seekingHandle !== 'target'
        return (
          <Handle
            key={`in-${port.id}`}
            type="target"
            position={Position.Left}
            id={port.id}
            className={cn(
              'aion-keycard-handle',
              isCompatible && 'aion-keycard-handle-compatible',
              isIncompatible && 'aion-keycard-handle-incompatible',
              isInactiveDirection && 'aion-keycard-handle-inactive-direction',
            )}
            title={port.label}
            style={{
              top,
              left: -4,
              borderColor: portColor,
            }}
          >
            <span
              className="aion-keycard-handle-hitarea"
              style={{ inset: '-10px 0px -10px -14px' }}
              aria-hidden="true"
            />
          </Handle>
        )
      })}

      {/* Output handles + inline add-next button */}
      {outputPorts.map((port) => {
        const top = outputPortHandleTop(meta, port.id)
        const portColor = PORT_COLORS[port.type] ?? nodeColor
        const active = data.connectingPortType != null && data.seekingHandle === 'source'
        const isCompatible = active && port.type === data.connectingPortType
        const isIncompatible = active && !isCompatible
        const isInactiveDirection = data.connectingPortType != null && data.seekingHandle !== 'source'
        const isConnecting = data.connectingPortType != null
        return (
          <div key={`out-${port.id}`}>
            <Handle
              type="source"
              position={Position.Right}
              id={port.id}
              className={cn(
                'aion-keycard-handle',
                isCompatible && 'aion-keycard-handle-compatible',
                isIncompatible && 'aion-keycard-handle-incompatible',
                isInactiveDirection && 'aion-keycard-handle-inactive-direction',
              )}
              title={port.label}
              style={{
                top,
                right: -4,
                borderColor: portColor,
              }}
            >
              <span
                className="aion-keycard-handle-hitarea"
                style={{ inset: '-10px -14px -10px 0px' }}
                aria-hidden="true"
              />
            </Handle>
            {data.onCreateNode && !isConnecting && (
              <Popover open={openMenuPortId === port.id} onOpenChange={(open) => setOpenMenuPortId(open ? port.id : null)}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      'absolute z-10 flex h-5 w-5 items-center justify-center rounded-full',
                      'border border-border/60 bg-card text-muted-foreground shadow-sm',
                      'transition-colors hover:border-primary hover:text-primary hover:bg-surface-2',
                    )}
                    style={{ top: top - 10, right: -22 }}
                    title="Add block"
                  >
                    <Plus className="h-3 w-3" />
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
    <div style={{ width: NODE_WIDTH, height: NODE_HEIGHT }} data-testid="keycard-start-node">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'group flex h-full w-full cursor-pointer items-center gap-0 overflow-hidden rounded-lg',
              'border border-dashed border-border/60 bg-card shadow-sm',
              'transition-colors hover:border-primary/50 hover:bg-surface-2',
            )}
          >
            <span className="flex h-full w-11 shrink-0 items-center justify-center bg-primary/10 text-primary">
              <Zap className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col items-start px-2.5 py-1 text-left">
              <span className="truncate text-xs font-semibold">Add trigger</span>
              <span className="truncate text-[10px] text-muted-foreground">Click to start</span>
            </div>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="right" sideOffset={12} className="w-60 p-2">
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


