/**
 * The pipeline in one line, above the canvas.
 *
 * This is the overview, and it exists because zooming out is not one. Seven
 * cards at a 308px pitch is about 2,100px wide; fitting that into a pane zooms
 * to roughly 0.6, where a 10px mono eyebrow is unreadable — so the canvas stays
 * at zoom 1 and pans, and the bird's-eye view is text instead of a smaller
 * picture.
 *
 * It carries the issue dots, which is the load-bearing part. Moving the wall of
 * warnings onto the cards would otherwise mean a problem can be off-screen; the
 * dots are always visible however far the canvas is panned.
 *
 * Also the breadcrumb, because the factor canvas is a place you go *into* from
 * the Features stage and need a marked way back out of.
 */
import { ChevronRight } from 'lucide-react'

import {
  PHASE_LABELS, PHASE_ORDER, STAGE_ORDER, STAGES, type StageId,
} from '@/lib/strategyGraph/stages'
import type { StageBadge } from '@/lib/strategyGraph/stageStatus'
import { cn } from '@/lib/utils'

export interface StageStripProps {
  selected: StageId | null
  onSelect: (stage: StageId) => void
  status: Readonly<Record<StageId, StageBadge>>
  /** Which pane the canvas area is showing. */
  pane: 'pipeline' | 'features'
  /** Leave the factor canvas and come back to the pipeline. */
  onBackToPipeline: () => void
  /** The feature column being edited, for the breadcrumb's leaf. */
  activeColumn?: string
}

export function StageStrip({
  selected, onSelect, status, pane, onBackToPipeline, activeColumn,
}: StageStripProps) {
  if (pane === 'features') {
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

  return (
    <nav
      aria-label="Pipeline stages"
      className="flex shrink-0 items-center gap-4 overflow-x-auto border-b border-border/50 px-6 py-2"
      data-testid="stage-strip"
    >
      {PHASE_ORDER.map((phase) => {
        const stages = STAGE_ORDER.filter((id) => STAGES[id].phase === phase)
        return (
          <div key={phase} className="flex shrink-0 items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50">
              {PHASE_LABELS[phase]}
            </span>
            {stages.map((id) => {
              const badge = status[id]
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelect(id)}
                  title={badge.notes.join('\n') || STAGES[id].label}
                  data-testid={`stage-chip-${id}`}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border px-2 py-1 transition-colors',
                    'font-mono text-[11px]',
                    selected === id
                      ? 'border-border bg-surface-3 text-foreground'
                      : 'border-border/50 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {STAGES[id].eyebrow}
                  {badge.status !== 'ok' && (
                    <span
                      aria-hidden
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        badge.status === 'blocked' ? 'bg-destructive' : 'bg-clay',
                      )}
                    />
                  )}
                </button>
              )
            })}
          </div>
        )
      })}
    </nav>
  )
}
