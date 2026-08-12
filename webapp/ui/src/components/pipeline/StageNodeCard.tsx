/**
 * One stage of the strategy, as a card on the pipeline canvas.
 *
 * A dumb printer of `StageCardData`. Every string it shows comes from
 * `lib/strategyGraph/glance.ts`, which is what makes the canvas testable in a
 * repo with no component tests -- there is nothing left in here worth asserting.
 *
 * The design deliberately diverges from the node editors it takes its shape
 * from, and each divergence does work rather than decoration:
 *
 *   - A left accent rail rather than a leading icon chip. The hue is identity
 *     (which phase), never a verdict, so it must not compete with the badge.
 *   - The *value* on the card, not just the label. This is `ExprNodeCard`'s own
 *     principle -- "a reader never has to trace edges" -- one level up, and it
 *     is the entire reason seven cards beat a scrolling form.
 *   - The house eyebrow above the label, as `Field` and `Panel` use.
 *   - An ordinal, because the pipeline is fixed and ordered and no node editor
 *     is usually able to say so.
 *   - Handles that are small and inert: nothing here is connectable, and a dot
 *     you cannot use must not look like one you can.
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  CalendarRange, Cpu, Database, Layers, ListFilter, Receipt, Sigma,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import type { StageIcon, StagePhase } from '@/lib/strategyGraph/stages'
import type { StageFlowNode } from '@/lib/strategyGraph/toFlow'
import { cn } from '@/lib/utils'

const STAGE_ICONS: Record<StageIcon, LucideIcon> = {
  database: Database,
  listFilter: ListFilter,
  sigma: Sigma,
  calendarRange: CalendarRange,
  cpu: Cpu,
  layers: Layers,
  receipt: Receipt,
}

/**
 * Four phases, four hues, seven cards.
 *
 * Adjacent stages sharing a colour is the point: it reads as one phase, which
 * is more information than seven arbitrary hues would carry -- and `index.css`
 * only reserves five `--type-*` identity hues in the first place.
 */
const TONE_RAIL: Record<StagePhase, string> = {
  data: 'bg-type-release',
  shape: 'bg-type-process',
  fit: 'bg-type-notification',
  execute: 'bg-type-trade',
}

const TONE_HAIRLINE: Record<StagePhase, string> = {
  data: 'bg-gradient-to-r from-type-release/60 to-transparent',
  shape: 'bg-gradient-to-r from-type-process/60 to-transparent',
  fit: 'bg-gradient-to-r from-type-notification/60 to-transparent',
  execute: 'bg-gradient-to-r from-type-trade/60 to-transparent',
}

export const StageNodeCard = memo(function StageNodeCard({ data }: NodeProps<StageFlowNode>) {
  const { stage, ordinal, glance, status, notes } = data
  const Icon = STAGE_ICONS[stage.icon]

  return (
    <div
      style={{ width: data.width, height: data.height }}
      // The reason travels with the card, the way it travels with the Run
      // button: a badge saying "2 blocking" with the sentences only in a rail
      // you have to open is a worse answer than no badge.
      title={notes.join('\n') || undefined}
      data-testid={`stage-card-${stage.id}`}
      className={cn(
        'aion-stage-card group relative flex cursor-pointer overflow-hidden rounded-xl',
        'border border-border/50 bg-card shadow-card transition-shadow hover:shadow-card-hover',
        status === 'blocked' && 'border-clay/50',
      )}
    >
      <span aria-hidden className={cn('w-[3px] shrink-0', TONE_RAIL[stage.phase])} />

      <div className="flex min-w-0 flex-1 flex-col px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {stage.eyebrow}
          </span>
          <Icon className="h-3 w-3 shrink-0 text-muted-foreground/50" />
          <span className="tnum ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/40">
            {ordinal}
          </span>
        </div>

        {/* What the stage is set to, not what a stage of this kind is for. The
            description is the same seven sentences for every strategy anyone
            will build; this is the line that differs — so this is the bold one.
            `stage.label` still names the stage in the inspector and the strip. */}
        <div
          title={stage.label}
          className="mt-1 truncate text-[15px] font-semibold leading-tight tracking-tight"
        >
          {glance.headline}
        </div>

        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {glance.detail.map((line) => (
            <span
              key={line.key}
              className={cn(
                'tnum max-w-full truncate font-mono text-[11px] text-muted-foreground',
                // A number the app worked out, not one that was typed. `500
                // names` is a fact about the store; `top500` is a choice, and
                // they should not read as the same kind of thing.
                line.computed && 'rounded bg-surface-2 px-1.5 py-0.5 text-muted-foreground/80',
                line.tone === 'clay' && 'text-clay',
              )}
            >
              {line.value}
            </span>
          ))}
        </div>

        {/* A count, not the sentence. A badge is a micro-pill and the notes are
            prose; they live in the `title` above and in the stage inspector.
            "advisory" rather than a severity word on purpose -- coverage never
            blocks a run, and a badge that reads like an error would teach
            people to ignore the ones that do. */}
        {status !== 'ok' && (
          <div className="mt-auto pt-1.5">
            <Badge variant={status === 'blocked' ? 'clay' : 'muted'} className="max-w-full truncate">
              {status === 'blocked' ? `${notes.length} blocking` : `${notes.length} advisory`}
            </Badge>
          </div>
        )}
      </div>

      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 h-px opacity-0',
          'transition-opacity duration-250 group-hover:opacity-100',
          TONE_HAIRLINE[stage.phase],
        )}
      />

      <Handle id="in" type="target" position={Position.Left} className="aion-stage-handle" />
      <Handle id="out" type="source" position={Position.Right} className="aion-stage-handle" />
    </div>
  )
})
