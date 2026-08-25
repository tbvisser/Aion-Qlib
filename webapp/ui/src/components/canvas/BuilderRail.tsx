/**
 * The builder's left rail.
 *
 * Two halves of one column: the blocks you build a feature out of, and the
 * things you start from. They share the search box, because "RSI" is a
 * reasonable thing to type whichever half you are looking at, and the tab
 * strip tells you which half answered.
 *
 * The rail is mounted in both panes. Blocks need an expression canvas to be
 * inserted into, so that tab is disabled in the pipeline pane and says why —
 * but templates and saved strategies are how you start from either pane, and
 * the old form view used to be the only place that showed your saved work at
 * all.
 */
import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'

import { TemplateRail } from '@/components/builder/TemplateRail'
import { BlockPalette } from '@/components/canvas/BlockPalette'
import { Input } from '@/components/ui/input'
import { RailTabs } from '@/components/ui/rail'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  CatalogFactor, FactorFamily, Indicator, StoredStrategy, StrategySpec,
} from '@/lib/api'
import type { ExprNode, OperatorRegistry } from '@/lib/factorExpr/types'

type Tab = 'blocks' | 'templates'

export interface BuilderRailProps {
  /**
   * Blocks are insertable only when there is a canvas to insert them into.
   *
   * The pipeline pane passes false and omits everything below it: the rail is
   * mounted there for its templates half, and the block vocabulary lives
   * inside `FactorCanvas` alongside the editor that would receive it.
   */
  canInsert: boolean
  registry?: OperatorRegistry
  fields?: string[]
  catalog?: CatalogFactor[]
  families?: FactorFamily[]
  indicators?: Indicator[]
  saved: StoredStrategy[]
  currentId?: string
  onInsert?: (node: ExprNode) => void
  onAdd?: (expression: string, name?: string) => void
  onUseTemplate: (spec: StrategySpec) => void
  onOpenSaved: (strategy: StoredStrategy) => void
  onDeleteSaved: (strategy: StoredStrategy) => void
  /**
   * Bumped to show the templates half.
   *
   * A nonce rather than a boolean: "Browse templates" in the header menu is a
   * request each time it is chosen, not a state to be held, and the rail owns
   * which tab it is on the rest of the time.
   */
  openTemplates?: number
}

export function BuilderRail({
  canInsert, registry = {}, fields = [], catalog = [], families = [], indicators = [],
  saved, currentId, onInsert, onAdd, onUseTemplate, onOpenSaved, onDeleteSaved,
  openTemplates = 0,
}: BuilderRailProps) {
  const [tab, setTab] = useState<Tab>(canInsert ? 'blocks' : 'templates')
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()

  // The pipeline pane has no expression canvas; land on the half that works there.
  const active: Tab = canInsert ? tab : 'templates'

  // The box is shared, the query is not. "vwap" is a fine thing to type at the
  // block list and a guaranteed empty state at the template list, and carrying
  // it across reads as the tab having nothing in it.
  const select = (next: Tab) => {
    setTab(next)
    setQuery('')
  }

  // Skips the first render: `openTemplates` starts at 0 and a mount is not a request.
  const firstNonce = useRef(openTemplates)
  useEffect(() => {
    if (openTemplates === firstNonce.current) return
    setTab('templates')
    setQuery('')
  }, [openTemplates])

  return (
    <TooltipProvider delayDuration={400}>
      <div
        data-testid="builder-rail"
        className="flex min-h-0 w-72 shrink-0 flex-col border-r border-border/50"
      >
        <RailTabs
          data-testid="builder-rail-tabs"
          value={active}
          onChange={select}
          tabs={[
            {
              value: 'blocks',
              label: 'Blocks',
              disabledReason: canInsert ? undefined : 'Blocks need the canvas.',
            },
            { value: 'templates', label: 'Templates' },
          ]}
        />

        <div className="relative shrink-0 border-b border-border/50 p-2">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={active === 'blocks' ? 'Search blocks' : 'Search templates'}
            className="h-8 pl-8 font-mono text-xs"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {active === 'blocks' && onInsert && onAdd ? (
            <BlockPalette
              registry={registry}
              fields={fields}
              catalog={catalog}
              families={families}
              indicators={indicators}
              needle={needle}
              onInsert={onInsert}
              onAdd={onAdd}
            />
          ) : (
            <TemplateRail
              needle={needle}
              saved={saved}
              currentId={currentId}
              onUse={onUseTemplate}
              onOpenSaved={onOpenSaved}
              onDeleteSaved={onDeleteSaved}
            />
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
