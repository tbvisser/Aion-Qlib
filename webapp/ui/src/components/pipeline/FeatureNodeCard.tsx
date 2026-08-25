/**
 * One custom feature column, as a chip tethered to the features card.
 *
 * A dumb printer of `FeatureChipData`, on the same terms as `StageNodeCard`:
 * every string comes from `lib/strategyGraph/toFlow.ts`, so the picture stays
 * assertable in a repo with no component tests.
 *
 * Deliberately not a small stage card. A chip is 156x40 against a card's
 * 72px-tall slab, has no header band, no watermark and no badge, and wears its
 * phase accent on the *left* edge rather than the bottom -- on something
 * hanging off the side of the stack, the edge that reads the same however the
 * fan grows is the one facing the card it belongs to. The one thing it does
 * share is the `core` handle, because the tether is the spoke idea one level
 * down.
 *
 * Three kinds, one card:
 *
 *   - `base`     the handler's own set, so the custom columns have something to
 *                be counted against. Struck through when the mode is `replace`,
 *                which is the canvas's only warning that 158 columns just left.
 *   - `column`   a column the user built. Name over expression.
 *   - `more`     the fan's own switch: the tail as a count while the fan is
 *                collapsed, and `show less` once it is open. Dashed and
 *                unfilled, because it is a control among things -- the columns
 *                around it are real, this chip is not one of them. Same id and
 *                same kind in both states, so it is relabelled rather than
 *                remounted, and the canvas routes it on one id comparison.
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

import type { FeatureFlowNode } from '@/lib/strategyGraph/toFlow'
import { cn } from '@/lib/utils'

export const FeatureNodeCard = memo(function FeatureNodeCard({
  data,
}: NodeProps<FeatureFlowNode>) {
  const { kind, title, subtitle, replaced } = data

  return (
    <div
      style={{ width: data.width, height: data.height }}
      // The expression is what a reader wants and what never fits.
      title={subtitle ?? undefined}
      data-testid={`feature-chip-${kind === 'column' ? title : kind}`}
      className={cn(
        'aion-feature-chip relative flex cursor-pointer flex-col justify-center overflow-hidden',
        'rounded-lg border border-border/50 bg-card px-2.5 shadow-card',
        'transition-shadow hover:shadow-card-hover',
        kind === 'more' && 'items-center border-dashed bg-transparent shadow-none',
        replaced && 'opacity-60',
      )}
    >
      {kind === 'more' ? (
        <span className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
      ) : (
        <>
          <span
            className={cn(
              'truncate font-mono text-label font-semibold leading-tight',
              replaced && 'line-through',
            )}
          >
            {title}
          </span>
          {subtitle && (
            <span className="truncate font-mono text-tiny leading-tight text-muted-foreground/70">
              {subtitle}
            </span>
          )}
        </>
      )}

      {/* The shape phase, on the edge facing the card these belong to. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-type-process/70"
      />

      {/* The tether's anchor: this chip's centre. See reactflow.css. */}
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
