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
 *   - A phase-hued *base rule* along the bottom rather than a left accent rail.
 *     A left rail said "this side is upstream", which was true on a row; on a
 *     ring a card at nine o'clock and one at three o'clock have no shared left,
 *     so the accent moved to an edge that reads the same at every bearing. The
 *     hue is still identity (which phase), never a verdict, so it must not
 *     compete with the badge.
 *   - The ordinal is promoted from a ghosted figure in the corner into the
 *     header band, because on a ring the number *is* the reading order -- there
 *     is no left-to-right to fall back on.
 *   - The *value* on the card, not just the label. This is `ExprNodeCard`'s own
 *     principle -- "a reader never has to trace edges" -- one level up, and it
 *     is the entire reason seven cards beat a scrolling form.
 *   - Detail stacked as rows rather than wrapped chips: 200px is narrow, and a
 *     wrap that reflows as a number changes width is noise.
 *   - Handles that are small and inert -- nothing here is connectable, and a dot
 *     you cannot use must not look like one you can -- and whose *side* now
 *     comes from the layout rather than being a hardcoded Left/Right.
 *
 * ## Bands, not one padded box
 *
 * The first version was a single `p-3` column, and the cards read as seven
 * identical grey boxes with a lot of nothing under the text: only `costs` ever
 * fills 148px, `learner` prints no detail line at all, and a badge appears on
 * maybe one card at a time. Three fixes, all inside the same 200x148 (the size
 * is load-bearing -- `layout.ts` feeds it to React Flow before first paint and
 * the ring geometry is derived from it):
 *
 *   - A `Panel`-style header band, phase-washed, with the icon inside the tinted
 *     tile instead of a bare glyph competing with a separate numeral medallion.
 *     Structure the eye can find at 0.85 zoom, which is the fit floor.
 *   - A footer strip that is never empty: the phase word sits opposite the
 *     badge, so the bottom of the card has a job on the six cards out of seven
 *     that have nothing to warn about.
 *   - A large, very faint phase-hued watermark of the stage's own icon in the
 *     body. It fills the dead corner with identity rather than content, so a
 *     card is recognisable by shape before any text is read -- and at 7% it
 *     cannot be mistaken for a verdict.
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  CalendarRange, Cpu, Database, Layers, ListFilter, Receipt, Sigma,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import type { Side } from '@/lib/strategyGraph/layout'
import { PHASE_LABELS, type StageIcon, type StagePhase } from '@/lib/strategyGraph/stages'
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

/** `layout.ts` stays free of `@xyflow/react`; this is where its sides land. */
const SIDE_POSITION: Record<Side, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
}

/**
 * Four phases, four hues, seven cards. Adjacent stages sharing a hue is the
 * point -- on a ring it draws four coloured arcs, which is the phase grouping the
 * strip used to spell out in words.
 */
const TONE_MEDALLION: Record<StagePhase, string> = {
  data: 'bg-type-release/10 text-type-release',
  shape: 'bg-type-process/10 text-type-process',
  fit: 'bg-type-notification/10 text-type-notification',
  execute: 'bg-type-trade/10 text-type-trade',
}

/** The ordinal and the footer's phase word: the hue at full strength on text. */
const TONE_TEXT: Record<StagePhase, string> = {
  data: 'text-type-release',
  shape: 'text-type-process',
  fit: 'text-type-notification',
  execute: 'text-type-trade',
}

/**
 * The header band. `Panel` washes its header `bg-foreground/[0.02]`; this is the
 * same move phase-tinted, so the band gives the card structure *and* tells four
 * families apart before a word is read. 6% is the most that stays behind the
 * text at 0.85 zoom in both themes.
 */
const TONE_WASH: Record<StagePhase, string> = {
  data: 'bg-type-release/[0.06]',
  shape: 'bg-type-process/[0.06]',
  fit: 'bg-type-notification/[0.06]',
  execute: 'bg-type-trade/[0.06]',
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
      // The reason travels with the card, as it does with the Run button.
      title={notes.join('\n') || undefined}
      data-testid={`stage-card-${stage.id}`}
      className={cn(
        'aion-stage-card group relative flex cursor-pointer flex-col overflow-hidden rounded-xl',
        'border border-border/50 bg-card shadow-card transition-shadow hover:shadow-card-hover',
        status === 'blocked' && 'border-clay/50',
      )}
    >
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 border-b border-border/40 px-2.5 py-1.5',
          TONE_WASH[stage.phase],
        )}
      >
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
            TONE_MEDALLION[stage.phase],
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        {/* Ordinal and name in one line rather than a medallion and a label at
            opposite ends: `01` is part of the stage's name here, not a score. */}
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-[0.12em]">
          <span className={cn('tnum font-medium', TONE_TEXT[stage.phase])}>{ordinal}</span>
          <span className="text-muted-foreground/70"> · {stage.eyebrow}</span>
        </span>
      </div>

      <div className="relative min-h-0 flex-1 px-3 pt-2">
        {/* The stage's own mark, big and nearly invisible. Identity, not
            content: it fills the corner the text never reaches on six of the
            seven cards. Behind everything, and clipped by the card's rounding. */}
        <Icon
          aria-hidden
          className={cn(
            'pointer-events-none absolute bottom-0 right-1 h-12 w-12 opacity-[0.07]',
            TONE_TEXT[stage.phase],
          )}
        />

        {/* What the stage is set to, not what a stage of this kind is for. The
            description is the same seven sentences for every strategy anyone will
            build; this is the line that differs. `stage.label` still names the
            stage in the inspector, and rides along in the tooltip here. */}
        <div
          title={`${stage.label} — ${glance.headline}`}
          className="relative truncate text-[17px] font-semibold leading-tight tracking-tight"
        >
          {glance.headline}
        </div>

        {/* Rows, not a wrap. `min-h-0` so a long row clips rather than pushing the
            badge out of the card; the inspector has the untruncated version. */}
        <div className="relative mt-1.5 flex min-h-0 flex-col items-start gap-1 overflow-hidden">
          {glance.detail.map((line) => (
            <span
              key={line.key}
              title={line.value}
              className={cn(
                'tnum max-w-full font-mono text-[11px] leading-snug',
                // A number the app worked out, not one that was typed. `500 names`
                // is a fact about the store; `top500` is a choice.
                line.computed
                  ? 'shrink-0 truncate rounded bg-surface-2 px-1.5 py-0.5 text-muted-foreground/80'
                  : 'line-clamp-2 text-muted-foreground',
                line.tone === 'clay' && 'text-clay',
              )}
            >
              {line.value}
            </span>
          ))}
        </div>
      </div>

      {/* Never empty: the phase word holds the left of the strip on the six
          cards that have nothing to warn about, so the bottom of a healthy card
          is composed rather than blank.

          The badge is a count, not the sentence. "advisory" rather than a
          severity word: coverage never blocks a run, and a badge that reads like
          an error would teach people to ignore the ones that do. */}
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-1">
        <span
          className={cn(
            'shrink-0 font-mono text-[9px] uppercase tracking-wider opacity-60',
            TONE_TEXT[stage.phase],
          )}
        >
          {PHASE_LABELS[stage.phase]}
        </span>
        {status !== 'ok' && (
          <Badge
            variant={status === 'blocked' ? 'clay' : 'muted'}
            className="min-w-0 truncate"
          >
            {status === 'blocked' ? `${notes.length} blocking` : `${notes.length} advisory`}
          </Badge>
        )}
      </div>

      {/* The phase, on the one edge that reads the same at every bearing. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 h-[2px]',
          TONE_BASE[stage.phase],
        )}
      />

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
