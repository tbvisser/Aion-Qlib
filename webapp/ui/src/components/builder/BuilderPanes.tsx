/**
 * The two canvases' shared frame, and the invariant that keeps them honest.
 *
 * Both panes are mounted, always. The inactive one is `invisible`
 * (visibility: hidden), never `hidden`/`display:none` and never unmounted —
 * three separate reasons:
 *
 * 1. `toSpecFeatures` emits only *complete* columns, so unmounting
 *    `FactorCanvas` silently deletes every half-built one.
 * 2. Unmounting would add a second, implicit reseed path via mount-time
 *    `seed()`, which is exactly what `specRevision`'s contract forbids: it
 *    must remain the only signal the canvas accepts, or an ordinary pane
 *    toggle reseeds mid-edit.
 * 3. `display: none` collapses the box to 0×0, which React Flow's
 *    ResizeObserver sees and the viewport never recovers from.
 *
 * Belt and braces on top of that: an opaque background and an explicit
 * z-order, so the active pane *covers* the other rather than merely
 * out-painting it. Nothing in either pane is opaque on its own — the rails,
 * the inspector and React Flow's `base.css` all set no background — so a
 * stale build that lost `invisible` rendered both node layers superimposed
 * rather than failing visibly. This makes that impossible whatever the cause.
 *
 * The panes arrive as children rather than being built here: their props are
 * the page's state, and threading thirty of them through a layout component
 * would couple it to everything. This component owns the frame and nothing
 * else.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** Which of the two canvases the pane area is showing. */
export type Pane = 'pipeline' | 'features'

export function BuilderPanes({ pane, pipeline, features }: {
  pane: Pane
  pipeline: ReactNode
  features: ReactNode
}) {
  return (
    <div className="relative min-h-0 flex-1">
      <div
        className={cn('absolute inset-0 flex overflow-hidden bg-background',
                      pane === 'pipeline' ? 'z-10' : 'z-0 invisible pointer-events-none')}
      >
        {pipeline}
      </div>

      <div
        className={cn('absolute inset-0 flex overflow-hidden bg-background',
                      pane === 'features' ? 'z-10' : 'z-0 invisible pointer-events-none')}
      >
        {features}
      </div>
    </div>
  )
}
