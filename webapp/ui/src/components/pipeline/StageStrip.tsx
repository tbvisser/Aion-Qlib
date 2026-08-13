/**
 * The breadcrumb out of the factor canvas.
 *
 * This was also the pipeline overview, and that existed because zooming out was
 * not one: seven cards on a row was about 2,000px, which fitted into a pane at
 * roughly 0.6 zoom, where a 10px mono eyebrow is unreadable. The ring replaced
 * the row and is 784x718 — it fits the pane at zoom 1, and the hub in its middle
 * carries the readiness and the seven issue dots the strip used to hold. So the
 * overview is the canvas again, the always-visible valve on a blocker is the
 * header's count chip, and the phase names are a legend inside the canvas where
 * the hues are.
 *
 * What is left is the part the canvas cannot do: the factor canvas is a place you
 * go *into* from the Features stage and need a marked way back out of. In the
 * pipeline pane this renders nothing, which is also worth 41px of canvas height
 * that the ring wants.
 */
import { ChevronRight } from 'lucide-react'

export interface StageStripProps {
  /** Which pane the canvas area is showing. */
  pane: 'pipeline' | 'features'
  /** Leave the factor canvas and come back to the pipeline. */
  onBackToPipeline: () => void
  /** The feature column being edited, for the breadcrumb's leaf. */
  activeColumn?: string
}

export function StageStrip({ pane, onBackToPipeline, activeColumn }: StageStripProps) {
  if (pane !== 'features') return null

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex shrink-0 items-center gap-1 border-b border-border/50 px-6 py-2"
      data-testid="stage-breadcrumb"
    >
      <button
        type="button"
        onClick={onBackToPipeline}
        className="rounded font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        Pipeline
      </button>
      <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
      <span className="font-mono text-[11px] uppercase tracking-wider text-foreground">
        Features
      </span>
      {activeColumn && (
        <>
          <span className="text-muted-foreground/40">·</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {activeColumn}
          </span>
        </>
      )}
    </nav>
  )
}
