/**
 * One stage of the strategy, as a narrow card on the vertical pipeline stack.
 *
 * A dumb printer of `StageCardData`. Every string it shows comes from
 * `lib/strategyGraph/glance.ts`, which is what makes the canvas testable in a
 * repo with no component tests -- there is nothing left in here worth asserting.
 *
 * The card is intentionally slim so the eight stages can stack vertically in a
 * narrow column. Color and icon identity are preserved from the previous design:
 * each phase keeps its hue on the icon tile and the bottom accent bar.
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  CalendarRange, Cpu, Database, Layers, ListFilter, MessageSquare, Receipt, Sigma,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import type { Side } from '@/lib/strategyGraph/layout'
import { PHASE_LABELS, type StageIcon, type StagePhase } from '@/lib/strategyGraph/stages'
import type { StageFlowNode } from '@/lib/strategyGraph/toFlow'
import { cn } from '@/lib/utils'

const STAGE_ICONS: Record<StageIcon, LucideIcon> = {
  messageSquare: MessageSquare,
  database: Database,
  listFilter: ListFilter,
  sigma: Sigma,
  calendarRange: CalendarRange,
  cpu: Cpu,
  layers: Layers,
  receipt: Receipt,
}

/** `layout.ts` stays free of `@xyflow/react`; this is where its sides land. */
const SIDE_POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

const TONE_MEDALLION: Record<StagePhase, string> = {
  data: 'bg-type-release/10 text-type-release',
  shape: 'bg-type-process/10 text-type-process',
  fit: 'bg-type-notification/10 text-type-notification',
  execute: 'bg-type-trade/10 text-type-trade',
}

const TONE_TEXT: Record<StagePhase, string> = {
  data: 'text-type-release',
  shape: 'text-type-process',
  fit: 'text-type-notification',
  execute: 'text-type-trade',
}

const TONE_BASE: Record<StagePhase, string> = {
  data: 'bg-type-release/70',
  shape: 'bg-type-process/70',
  fit: 'bg-type-notification/70',
  execute: 'bg-type-trade/70',
}

export const StageNodeCard = memo(function StageNodeCard({
  data,
}: NodeProps<StageFlowNode>) {
  const { stage, ordinal, glance, status, notes, sides } = data
  const Icon = STAGE_ICONS[stage.icon]

  return (
    <div
      style={{ width: data.width, height: data.height }}
      title={notes.join('\n') || undefined}
      data-testid={`stage-card-${stage.id}`}
      className={cn(
        'aion-stage-card group relative flex cursor-pointer items-center overflow-hidden rounded-xl',
        'border border-border/50 bg-card shadow-card transition-shadow hover:shadow-card-hover',
        status === 'blocked' && 'border-clay/50',
      )}
    >
      {/* Phase accent along the bottom edge. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 h-[2px]',
          TONE_BASE[stage.phase],
        )}
      />

      {/* Icon tile: the stage's identity, phase-tinted. */}
      <span
        className={cn(
          'ml-2.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
          TONE_MEDALLION[stage.phase],
        )}
      >
        <Icon className="h-4 w-4" />
      </span>

      {/* Headline and detail, left-aligned and truncated. */}
      <div className="flex min-w-0 flex-1 flex-col justify-center px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'tnum shrink-0 font-mono text-tiny uppercase tracking-wider',
              TONE_TEXT[stage.phase],
            )}
          >
            {ordinal}
          </span>
          <span className="truncate font-mono text-tiny uppercase tracking-wider text-muted-foreground/70">
            · {stage.eyebrow}
          </span>
        </div>

        <div
          title={`${stage.label} — ${glance.headline}`}
          className="mt-0.5 min-w-0 truncate text-sm font-semibold leading-tight tracking-tight"
        >
          {glance.headline}
        </div>

        {glance.detail.length > 0 && (
          <div className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden">
            {glance.detail.slice(0, 2).map((line) => (
              <span
                key={line.key}
                title={line.value}
                className={cn(
                  'tnum max-w-full shrink-0 truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-tiny text-muted-foreground/80',
                  line.tone === 'clay' && 'text-clay',
                )}
              >
                {line.value}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Status badge, when there is something to say. */}
      {status !== 'ok' && (
        <Badge
          variant={status === 'blocked' ? 'clay' : 'muted'}
          className="mr-2.5 shrink-0 truncate text-tiny"
        >
          {status === 'blocked' ? `${notes.length} blocking` : `${notes.length} advisory`}
        </Badge>
      )}

      {/* Phase label tucked into the unused corner, matching the bottom accent. */}
      <span
        className={cn(
          'pointer-events-none absolute bottom-2 right-2.5 font-mono text-tiny uppercase tracking-wider opacity-40',
          TONE_TEXT[stage.phase],
        )}
      >
        {PHASE_LABELS[stage.phase]}
      </span>

      <Handle id="in" type="target" position={SIDE_POSITION[sides.in]} className="aion-stage-handle" />
      <Handle id="out" type="source" position={SIDE_POSITION[sides.out]} className="aion-stage-handle" />
      {/* The spoke's anchor: this card's centre. See reactflow.css. */}
      <Handle
        id="core"
        type="target"
        position={Position.Top}
        style={{ top: '50%' }}
        className="aion-core-handle"
      />
    </div>
  )
})
