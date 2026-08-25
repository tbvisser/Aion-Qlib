/**
 * What the eight cards add up to, at the top of the vertical stack.
 *
 * A dumb printer, like `StageNodeCard`: every number comes from `toHubNode`,
 * derived from the same badges the cards wear, so the hub cannot disagree with
 * the stack below it. Deliberately *not* a stage card -- `bg-surface-2` and
 * `rounded-2xl`, so it reads as a summary rather than a ninth stage.
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

import { Badge } from '@/components/ui/badge'
import { STAGES } from '@/lib/strategyGraph/stages'
import type { StageStatus } from '@/lib/strategyGraph/stageStatus'
import type { HubFlowNode } from '@/lib/strategyGraph/toFlow'
import { cn } from '@/lib/utils'

/**
 * The card's badge language, shrunk to a dot: clay is a blocker, muted is an
 * advisory, mint is nothing to say. Never `--destructive` -- a strategy that
 * cannot run yet is a verdict about the configuration, not something that broke.
 */
const DOT: Record<StageStatus, string> = {
  ok: 'bg-primary/60',
  attention: 'bg-muted-foreground/50',
  blocked: 'bg-clay',
}

export const StageHubCard = memo(function StageHubCard({
  data,
}: NodeProps<HubFlowNode>) {
  const { name, ready, total, blocking, advisory, dots } = data

  return (
    <div
      style={{ width: data.width, height: data.height }}
      data-testid="pipeline-hub"
      className={cn(
        'aion-hub-card relative flex flex-col items-center justify-center gap-1',
        'rounded-2xl border bg-surface-2 px-3 py-1.5 text-center',
        // The glow is the one place on this canvas that says "ready". It is the
        // `--ring` hue via `shadow-glow`, not a hand-tuned colour.
        blocking === 0 ? 'border-border shadow-glow' : 'border-clay/40',
      )}
    >
      <span className="font-mono text-tiny uppercase tracking-[0.14em] text-muted-foreground/60">
        Strategy
      </span>

      <div
        title={name}
        className="line-clamp-1 text-sm font-semibold leading-tight tracking-tight"
      >
        {name}
      </div>

      <div className="tnum font-mono text-micro text-muted-foreground">
        {ready} of {total} ready
      </div>

      {/* The stack in miniature, in the same order. Not decoration: it is the
          thing that stays legible when the canvas is panned or zoomed out. */}
      <div className="flex items-center gap-1.5">
        {dots.map((dot) => (
          <span
            key={dot.id}
            title={STAGES[dot.id].eyebrow}
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT[dot.status])}
          />
        ))}
      </div>

      {(blocking > 0 || advisory > 0) && (
        <div className="flex flex-wrap items-center justify-center gap-1">
          {blocking > 0 && <Badge variant="clay">{blocking} blocking</Badge>}
          {advisory > 0 && <Badge variant="muted">{advisory} advisory</Badge>}
        </div>
      )}

      {/* Every spoke leaves from here -- the hub's own centre. See reactflow.css. */}
      <Handle
        id="core"
        type="source"
        position={Position.Top}
        style={{ top: '50%' }}
        className="aion-core-handle"
      />
    </div>
  )
})
