/**
 * The right rail: the selected stage's fields.
 *
 * Nothing is rendered when nothing is selected — not even a placeholder. It
 * used to hold a prose summary of the strategy, which was written when the
 * canvas could not show the strategy itself; now that each card prints its own
 * value, the summary was restating seven cards in seven sentences beside them,
 * and permanently costing the canvas 320px to do it.
 */
import { Notice } from '@/components/ui/notice'
import type { StageId } from '@/lib/strategyGraph/stages'
import { STAGES } from '@/lib/strategyGraph/stages'
import { ContextInspector } from './inspectors/ContextInspector'
import { CostsInspector } from './inspectors/CostsInspector'
import { FeaturesInspector } from './inspectors/FeaturesInspector'
import { LearnerInspector } from './inspectors/LearnerInspector'
import { PeriodsInspector } from './inspectors/PeriodsInspector'
import { PortfolioInspector } from './inspectors/PortfolioInspector'
import { StoreInspector } from './inspectors/StoreInspector'
import { UniverseInspector } from './inspectors/UniverseInspector'
import type { InspectorComponent, InspectorProps } from './inspectors/types'

const INSPECTORS: Record<StageId, InspectorComponent> = {
  context: ContextInspector,
  store: StoreInspector,
  universe: UniverseInspector,
  features: FeaturesInspector,
  periods: PeriodsInspector,
  learner: LearnerInspector,
  portfolio: PortfolioInspector,
  costs: CostsInspector,
}

export interface StageInspectorProps extends InspectorProps {
  selected: StageId | null
  /** Blockers routed to the selected stage. Advisories are inside `notes`. */
  blocking: string[]
}

export function StageInspector({ selected, blocking, ...props }: StageInspectorProps) {
  // The canvas gets the width back when nothing is selected.
  if (selected === null) return null

  const Inspector = INSPECTORS[selected]

  return (
    <aside
      className="w-80 shrink-0 space-y-3 overflow-y-auto border-l border-border/50 p-4"
      data-testid="stage-inspector"
    >
      <div className="space-y-0.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {STAGES[selected].eyebrow}
        </span>
        <p className="text-[13px] text-muted-foreground">{STAGES[selected].label}</p>
      </div>

      {/* The sentences behind the card's badge. The badge can only carry a
          count; this is where the reason actually lives. */}
      {blocking.length > 0 && (
        <Notice tone="clay">
          <div className="space-y-1">
            {blocking.map((w) => <p key={w}>{w}</p>)}
          </div>
        </Notice>
      )}

      <Inspector {...props} />
    </aside>
  )
}
