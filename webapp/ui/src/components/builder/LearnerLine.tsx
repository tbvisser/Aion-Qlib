/**
 * Which learner trains this strategy — as a sentence, not two dropdowns.
 *
 * The Builder is where a strategy is written: what it holds, over what period,
 * at what cost. Which model fits it is a different question, and it is the one
 * ML Studio exists to answer across several attempts at once. Standing at the
 * top of the definition form as two required-looking selects, it read as the
 * first decision rather than a setting with a sensible default.
 *
 * Nothing is hidden. The same two `Choice` controls are one click away in
 * Change — the move the qrun YAML made when it went behind `Config`, and for
 * the same reason: what runs must stay reachable, it just should not be the
 * loudest thing on the page.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Cpu } from 'lucide-react'

import { Choice, Field } from './FormControls'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ModelsResponse, StrategySpec } from '@/lib/api'
import { cn } from '@/lib/utils'

export function LearnerLine({ spec, setSpec, models, className }: {
  spec: StrategySpec
  setSpec: React.Dispatch<React.SetStateAction<StrategySpec>>
  models: ModelsResponse | null
  /** The caller owns the layout — `Section` is a two-column grid. */
  className?: string
}) {
  const [open, setOpen] = useState(false)

  // The catalog's label ("LightGBM"), falling back to the id. A spec carrying a
  // model this machine cannot offer — a template, an older saved strategy —
  // still names it rather than rendering blank, which is the same rule the
  // benchmark select follows.
  const label = models?.models.find((m) => m.id === spec.model)?.label ?? spec.model

  return (
    <div
      data-testid="learner-line"
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/50 px-3 py-2',
        className,
      )}
    >
      <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="text-[13px]">
        Trained with <span className="font-medium">{label}</span> on{' '}
        <span className="font-medium">{spec.handler}</span>
      </span>

      <div className="ml-auto flex items-center gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" data-testid="learner-change">Change</Button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="end" className="w-72 space-y-3 p-3">
            <Field label="Model">
              <Choice
                value={spec.model}
                onChange={(v) => setSpec((prev) => ({ ...prev, model: v }))}
                options={(models?.models ?? []).map((m) => ({ value: m.id, label: m.label }))}
              />
            </Field>
            <Field
              label="Feature set"
              hint="What the model sees: Alpha158 is 158 engineered factors, Alpha360 is 360 raw price and volume lags."
            >
              <Choice
                value={spec.handler}
                onChange={(v) => setSpec((prev) => ({ ...prev, handler: v }))}
                options={(models?.handlers ?? ['Alpha158']).map((h) => ({ value: h, label: h }))}
              />
            </Field>
          </PopoverContent>
        </Popover>

        {/* Not a hint that a sweep is possible somewhere — the link itself. The
            page it points at is the one that can answer "which of these is
            better", and it needs the strategy saved to do it. */}
        <Link
          to="/lab/ml-studio"
          title="Save this strategy, then train it against several models at once"
          className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          Sweep several
          <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  )
}
