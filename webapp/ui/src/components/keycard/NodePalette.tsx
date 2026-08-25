import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Brain,
  Briefcase,
  CalendarClock,
  CalendarRange,
  CandlestickChart,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  FileText,
  Filter,
  Layers,
  LayoutTemplate,
  MessageSquare,
  Newspaper,
  Puzzle,
  Receipt,
  RotateCcw,
  Search,
  Sigma,
  TrendingUp,
  X,
  type LucideIcon,
} from 'lucide-react'

import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { RailTabs } from '@/components/ui/rail'
import { api, type Keycard, type KeycardNodeCategory, type KeycardNodeTypeMeta } from '@/lib/api'
import { FALLBACK_NODE_CATEGORIES, NODE_CATEGORY_INFO, type NodeCategory, type NodeCategoryInfo } from '@/lib/keycardGraph/nodeRegistry'
import { KEYCARD_HUES, NEUTRAL_HUE, solid, wash } from '@/lib/keycardGraph/palette'
import { STATIC_KEYCARD_TEMPLATES } from '@/lib/keycardGraph/keycardTemplates'
import { cn } from '@/lib/utils'

interface Props {
  onUseTemplate: (keycard: Keycard) => void
}

const ICONS: Record<string, LucideIcon> = {
  database: Database,
  globe: Box,
  layers: Layers,
  brain: Brain,
  briefcase: Briefcase,
  'dollar-sign': Box,
  'file-text': FileText,
  sigma: Sigma,
  cpu: Cpu,
  receipt: Receipt,
  'list-filter': Box,
  'calendar-range': CalendarRange,
  'calendar-clock': CalendarClock,
  'candlestick-chart': CandlestickChart,
  filter: Filter,
  newspaper: Newspaper,
  'rotate-ccw': RotateCcw,
  'trending-up': TrendingUp,
  'message-square': MessageSquare,
  puzzle: Puzzle,
}

function getIcon(name: string | null | undefined): LucideIcon {
  if (name && name in ICONS) return ICONS[name]
  return Box
}

function getCategoryIcon(cat: NodeCategoryInfo): LucideIcon {
  return getIcon(cat.icon)
}

type Tab = 'blocks' | 'templates'

/** `color` is a hue reference from `palette.ts` — wrap in `solid()` to paint. */
const TEMPLATE_FAMILY_INFO: Record<string, { label: string; color: string }> = {
  baseline: { label: 'Baseline', color: KEYCARD_HUES.emerald },
  factors: { label: 'Strategy', color: KEYCARD_HUES.emerald },
  shape: { label: 'Management', color: KEYCARD_HUES.violet },
  universe: { label: 'Universe', color: KEYCARD_HUES.blue },
  horizon: { label: 'Horizon', color: KEYCARD_HUES.amber },
  cost: { label: 'Cost', color: KEYCARD_HUES.rose },
  'model-comparison': { label: 'Model comparison', color: KEYCARD_HUES.cyan },
  aion: { label: 'Aion Blocks', color: KEYCARD_HUES.orange },
  examples: { label: 'Examples', color: KEYCARD_HUES.cyan },
}

export function NodePalette({ onUseTemplate }: Props) {
  const [tab, setTab] = useState<Tab>('blocks')
  const [categories, setCategories] = useState<KeycardNodeCategory[]>([])
  const [templates, setTemplates] = useState<Keycard[]>([])
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>({})
  const [openTemplateFamilies, setOpenTemplateFamilies] = useState<Record<string, boolean>>({})
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [apiReady, setApiReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.listNodeTypes(),
      api.listKeycards({ is_template: true }),
    ])
      .then(([typesRes, keycardsRes]) => {
        if (cancelled) return
        setCategories(mergeCategories(FALLBACK_NODE_CATEGORIES, typesRes.node_types))
        setTemplates(mergeTemplates(keycardsRes.keycards, STATIC_KEYCARD_TEMPLATES))
        const initialOpen: Record<string, boolean> = {}
        mergeCategories(FALLBACK_NODE_CATEGORIES, typesRes.node_types).forEach((cat) => {
          initialOpen[cat.id] = true
        })
        setOpenCategories(initialOpen)
        setOpenTemplateFamilies({})
        setApiReady(true)
      })
      .catch(() => {
        if (cancelled) return
        setCategories(FALLBACK_NODE_CATEGORIES)
        setTemplates(STATIC_KEYCARD_TEMPLATES)
        const initialOpen: Record<string, boolean> = {}
        FALLBACK_NODE_CATEGORIES.forEach((cat) => { initialOpen[cat.id] = true })
        setOpenCategories(initialOpen)
        setOpenTemplateFamilies({})
        setApiReady(false)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const filteredCategories = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return categories
    return categories
      .map((cat) => ({
        ...cat,
        items: cat.items.filter(
          (item) =>
            item.label.toLowerCase().includes(q) ||
            (item.description ?? '').toLowerCase().includes(q),
        ),
      }))
      .filter((cat) => cat.items.length > 0)
  }, [categories, search])

  const filteredTemplates = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return templates
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q)),
    )
  }, [templates, search])

  const groupedTemplates = useMemo(() => {
    const byFamily = new Map<string, Keycard[]>()
    for (const t of filteredTemplates) {
      const family = t.template_family ?? 'Other'
      if (!byFamily.has(family)) byFamily.set(family, [])
      byFamily.get(family)!.push(t)
    }
    // Stable order: Aion blocks first, then strategy-like families, then alphabetically.
    const order = ['aion', 'baseline', 'factors', 'shape', 'universe', 'horizon', 'cost', 'model-comparison']
    const sorted = Array.from(byFamily.entries()).sort((a, b) => {
      const ia = order.indexOf(a[0])
      const ib = order.indexOf(b[0])
      if (ia !== -1 && ib !== -1) return ia - ib
      if (ia !== -1) return -1
      if (ib !== -1) return 1
      return a[0].localeCompare(b[0])
    })
    return sorted.map(([family, items]) => [family, items.sort((x, y) => x.name.localeCompare(y.name))] as const)
  }, [filteredTemplates])

  const onDragStart = (event: React.DragEvent, meta: KeycardNodeTypeMeta) => {
    event.dataTransfer.setData('application/aion-keycard-node', JSON.stringify({ type: meta.id }))
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border/50 bg-card">
      {/* `RailTabs`, not `Segmented` — its own docblock draws the line: a
          Segmented is a mode pill inside a panel, and this is a full-width
          switch between two halves of a rail, same as the strategy builder's. */}
      <RailTabs
        data-testid="keycard-rail-tabs"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'blocks', label: 'Blocks' },
          { value: 'templates', label: 'Templates' },
        ]}
      />

      <div className="relative shrink-0 border-b border-border/50 p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={tab === 'blocks' ? 'Search blocks' : 'Search templates'}
          className="h-8 pl-8 pr-7 font-mono text-xs"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!apiReady && !loading && (
          <p className="px-2 py-2 text-label text-muted-foreground">
            Backend offline — showing the built-in blocks; connect it for the full library.
          </p>
        )}

        {tab === 'templates' && (
          <div className="space-y-1">
            {loading && templates.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">Loading…</p>
            ) : groupedTemplates.length === 0 ? (
              <p className="px-2 py-4 text-label text-muted-foreground">
                {search ? `Nothing matches “${search.trim()}”.` : 'Nothing to start from yet.'}
              </p>
            ) : (
              groupedTemplates.map(([family, items]) => {
                const info = TEMPLATE_FAMILY_INFO[family] ?? {
                  label: family,
                  color: NEUTRAL_HUE,
                }
                const open = openTemplateFamilies[family] ?? true
                return (
                  <Collapsible
                    key={family}
                    open={open}
                    onOpenChange={(isOpen) =>
                      setOpenTemplateFamilies((prev) => ({ ...prev, [family]: isOpen }))}
                  >
                    <CollapsibleTrigger asChild>
                      <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-label font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
                        {open
                          ? <ChevronDown className="h-3.5 w-3.5" />
                          : <ChevronRight className="h-3.5 w-3.5" />}
                        <span style={{ color: solid(info.color) }}>{info.label}</span>
                        <span className="ml-auto font-mono text-micro text-muted-foreground/60">
                          {items.length}
                        </span>
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ul className="space-y-0.5 py-1 pl-4">
                        {items.map((t) => (
                          <li key={t.id}>
                            <button
                              className="w-full rounded-md px-2 py-1.5 text-left text-label hover:bg-accent"
                              onClick={() => onUseTemplate(t)}
                              title={t.description}
                            >
                              <div className="flex items-center gap-2">
                                <LayoutTemplate className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="truncate font-medium">{t.name}</span>
                              </div>
                              {t.tags.length > 0 && (
                                <div className="truncate pl-5 text-micro text-muted-foreground">
                                  {t.tags.join(', ')}
                                </div>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                )
              })
            )}
          </div>
        )}

        {tab === 'blocks' && (
          <div className="space-y-1">
            {loading && categories.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">Loading…</p>
            ) : filteredCategories.length === 0 ? (
              <p className="px-2 py-4 text-label text-muted-foreground">
                {search ? `Nothing matches “${search.trim()}”.` : 'No blocks available.'}
              </p>
            ) : (
              filteredCategories.map((category) => {
                const catInfo = NODE_CATEGORY_INFO[category.id as NodeCategory] ?? {
                  id: category.id,
                  label: category.label,
                  icon: 'puzzle',
                  color: NEUTRAL_HUE,
                }
                const CatIcon = getCategoryIcon(catInfo)
                const open = openCategories[category.id] ?? true
                return (
                  <Collapsible
                    key={category.id}
                    open={open}
                    onOpenChange={(isOpen) =>
                      setOpenCategories((prev) => ({ ...prev, [category.id]: isOpen }))}
                  >
                    <CollapsibleTrigger asChild>
                      <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-label font-medium uppercase tracking-wider text-muted-foreground hover:bg-accent">
                        {open
                          ? <ChevronDown className="h-3.5 w-3.5" />
                          : <ChevronRight className="h-3.5 w-3.5" />}
                        <CatIcon className="h-3.5 w-3.5" style={{ color: solid(catInfo.color) }} />
                        {catInfo.label}
                        <span className="ml-auto font-mono text-micro text-muted-foreground/60">
                          {category.items.length}
                        </span>
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ul className="space-y-0.5 py-1 pl-4">
                        {category.items.map((meta) => {
                          const Icon = getIcon(meta.icon)
                          return (
                            <li key={meta.id}>
                              <div
                                draggable
                                onDragStart={(e) => onDragStart(e, meta)}
                                className={cn(
                                  'group flex cursor-grab items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-label transition-colors hover:border-border/50 hover:bg-accent active:cursor-grabbing',
                                )}
                                title={meta.description}
                              >
                                <span
                                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                                  style={{ background: wash(catInfo.color), color: solid(catInfo.color) }}
                                >
                                  <Icon className="h-3 w-3" />
                                </span>
                                <span className="truncate font-medium">{meta.label}</span>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                )
              })
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

/**
 * Merge backend-returned categories on top of the static fallback registry.
 * This guarantees new Aion-style blocks still appear even if the backend
 * has not been updated with the latest node types.
 */
function mergeCategories(
  fallback: KeycardNodeCategory[],
  api: KeycardNodeCategory[],
): KeycardNodeCategory[] {
  const byId = new Map<string, KeycardNodeCategory>()
  for (const cat of fallback) {
    byId.set(cat.id, { ...cat, items: [...cat.items] })
  }
  for (const cat of api) {
    const existing = byId.get(cat.id)
    if (!existing) {
      byId.set(cat.id, { ...cat, items: [...cat.items] })
      continue
    }
    const existingIds = new Set(existing.items.map((i) => i.id))
    for (const item of cat.items) {
      if (!existingIds.has(item.id)) {
        existing.items.push(item)
      }
    }
  }
  return Array.from(byId.values())
}

/**
 * Merge backend-returned templates on top of the static fallback set.
 * Server-side templates win when ids collide, so running the migration script
 * does not create duplicates.
 */
function mergeTemplates(api: Keycard[], fallback: Keycard[]): Keycard[] {
  const byId = new Map<string, Keycard>()
  for (const t of fallback) {
    byId.set(t.id, t)
  }
  for (const t of api) {
    byId.set(t.id, t)
  }
  return Array.from(byId.values())
}
