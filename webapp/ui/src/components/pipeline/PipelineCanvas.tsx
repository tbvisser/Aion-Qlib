/**
 * The strategy, drawn as its seven stages in a vertical stack with a hub above.
 *
 * The spec is the source of truth and this graph is derived from it on every
 * render -- nothing is written back, not even positions. That is the same rule
 * `FactorCanvas` holds for expression trees, and it is what makes an
 * out-of-sync canvas impossible here: there is no graph to get out of step
 * with, because the graph is a projection.
 *
 * The pipeline is fixed. Stages cannot be added, removed, reconnected or
 * dragged, so every affordance that would suggest otherwise is off.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Background, BackgroundVariant, Controls, Panel, ReactFlow, useReactFlow, useStore,
  type FitViewOptions, type NodeTypes,
} from '@xyflow/react'

import { FeatureNodeCard } from './FeatureNodeCard'
import { StageEdge } from './StageEdge'
import { StageHubCard } from './StageHubCard'
import { StageNodeCard } from './StageNodeCard'
import type { StrategySpec } from '@/lib/api'
import type { GlanceContext } from '@/lib/strategyGraph/glance'
import {
  STAGE_H, STAGE_WIDTHS, featureBlockBounds, stagePositions,
} from '@/lib/strategyGraph/layout'
import {
  PHASE_LABELS, PHASE_ORDER, isStageId, type StageId, type StagePhase,
} from '@/lib/strategyGraph/stages'
import type { StageBadge } from '@/lib/strategyGraph/stageStatus'
import {
  FEATURE_MORE_ID, FEATURE_NODE_TYPE, HUB_NODE_ID, HUB_NODE_TYPE,
  STAGE_EDGE_TYPE, STAGE_NODE_TYPE,
  hasFeatureOverflow, isFeatureNodeId, pipelineEdges, toPipelineNodes,
} from '@/lib/strategyGraph/toFlow'
import { cn } from '@/lib/utils'

import '@xyflow/react/dist/base.css'
import '@/styles/reactflow.css'

/** Must be referentially stable or React Flow remounts every node each render. */
const nodeTypes: NodeTypes = {
  [STAGE_NODE_TYPE]: StageNodeCard,
  [HUB_NODE_TYPE]: StageHubCard,
  [FEATURE_NODE_TYPE]: FeatureNodeCard,
}

const edgeTypes = {
  [STAGE_EDGE_TYPE]: StageEdge,
}

/** The legend the strip used to spell out, back where the hues actually are. */
const PHASE_DOT: Record<StagePhase, string> = {
  data: 'bg-type-release/70',
  shape: 'bg-type-process/70',
  fit: 'bg-type-notification/70',
  execute: 'bg-type-trade/70',
}

/**
 * Fit-to-view, floored.
 *
 * `fitView` was rejected while the pipeline was a row: seven cards was ~2,000px,
 * which fitted into a pane at about 0.6 zoom, where a 10px mono eyebrow is
 * unreadable. The vertical stack is a narrow column, so the arithmetic is
 * different -- it fits at zoom 1 in every pane this app sees except the
 * narrowest.
 *
 *   maxZoom 1     never zoom *in*: a card is never bigger than it was designed.
 *   minZoom 0.85  never zoom out past 0.85, where the card's 9px eyebrow still
 *                 renders at 7.65px. Past that the stack overflows and you pan --
 *                 which is what you are doing anyway with the inspector open.
 */
const FIT_PADDING = 0.08
const FIT_MIN_ZOOM = 0.85
const FIT_MAX_ZOOM = 1
const FIT: FitViewOptions = {
  padding: FIT_PADDING, minZoom: FIT_MIN_ZOOM, maxZoom: FIT_MAX_ZOOM, duration: 220,
}

/**
 * The overview when nothing is selected, the card itself when something is, and
 * the features card with its chips while the fan is open.
 *
 * The ring is centred on the origin, so there is no static `defaultViewport` that
 * works: the pane has to be told where the centre is once it has been measured.
 * Selecting a stage pans to it without changing the zoom; clicking the pane
 * clears the selection and the whole ring comes back.
 *
 * Expanded outranks both, because it is the thing you just asked to look at. It
 * frames the fan rather than the picture: the ring plus a full grid would have
 * to be shown at zoom 0.54, well under the floor where the cards stop being
 * readable, while the fan alone never needs less than 0.91 at any count. On
 * collapse the other two rules take over unchanged.
 */
function ViewportDirector({
  selected, expanded, chipCount,
}: {
  selected: StageId | null
  expanded: boolean
  chipCount: number
}) {
  const { setCenter, getZoom, fitView } = useReactFlow()
  const paneW = useStore((s) => s.width)
  const paneH = useStore((s) => s.height)
  useEffect(() => {
    if (expanded) {
      // Framed from the geometry rather than by naming nodes or handing the box
      // to `fitBounds`. `fitView`'s `nodes` option resolves ids against the
      // store, and on the render that opens the fan the new chips are not in it
      // yet, so it finds a stale set and leaves the viewport alone; `fitBounds`
      // clamps only to the *component's* 0.3-1.5, so a small fan would be blown
      // up past the size the cards were drawn at. Computing the zoom keeps it
      // in the same 0.85-1 band `FIT` holds everywhere else.
      const box = featureBlockBounds(chipCount, true)
      const raw = Math.min(
        (paneW * (1 - 2 * FIT_PADDING)) / box.width,
        (paneH * (1 - 2 * FIT_PADDING)) / box.height,
      )
      const zoom = Math.min(FIT_MAX_ZOOM, Math.max(FIT_MIN_ZOOM, raw))
      void setCenter(box.x + box.width / 2, box.y + box.height / 2, { zoom, duration: 220 })
      return
    }
    if (!selected) {
      void fitView(FIT)
      return
    }
    const at = stagePositions()[selected]
    void setCenter(at.x + STAGE_WIDTHS[selected] / 2, at.y + STAGE_H / 2, {
      zoom: getZoom(), duration: 220,
    })
    // `chipCount` is a scalar on purpose. The node list it comes from is
    // rebuilt whenever a glance string changes, so depending on that would yank
    // the viewport back to the fan on every keystroke that edits an expression;
    // the count only moves when a column is added or removed, which is exactly
    // when a refit is wanted.
  }, [expanded, chipCount, selected, paneW, paneH, setCenter, getZoom, fitView])
  return null
}

export interface PipelineCanvasProps {
  spec: StrategySpec
  glance?: GlanceContext
  status?: Readonly<Record<StageId, StageBadge>>
  selected: StageId | null
  onSelect: (stage: StageId | null) => void
  /** Double-clicking Features opens the factor canvas; the page owns that pane. */
  onOpenStage?: (stage: StageId) => void
}

export function PipelineCanvas({
  spec, glance, status, selected, onSelect, onOpenStage,
}: PipelineCanvasProps) {
  const [expanded, setExpanded] = useState(false)
  // Gate rather than trust. A flag left over from a strategy with twenty
  // columns must not draw a grid for one that now has two -- and deriving the
  // gate makes that right in the same render, with no effect and no frame of a
  // stale picture. Keying on the column *count* instead would be wrong the
  // other way: adding a column while open would slam the fan shut mid-edit.
  const overflows = hasFeatureOverflow(spec)
  const open = expanded && overflows
  if (expanded && !overflows) setExpanded(false)

  const nodes = useMemo(
    () => toPipelineNodes(spec, glance, status, open)
      .map((n) => ({ ...n, selected: n.id === selected })),
    [spec, glance, status, selected, open],
  )
  const edges = useMemo(() => pipelineEdges(status, spec, open), [status, spec, open])

  // How many chips the fan is drawing, which is what the viewport frames by.
  const chipCount = useMemo(
    () => nodes.filter((n) => isFeatureNodeId(n.id)).length,
    [nodes],
  )

  return (
    <div className="relative min-h-0 min-w-0 flex-1" data-testid="pipeline-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // The whole picture is derived. Position changes have nowhere to go and
        // selection is the page's state, so React Flow is told about neither.
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        // Replaces `defaultViewport`: the stack is centred on the origin, so the
        // first viewport can only be computed once the pane has been measured.
        fitView
        fitViewOptions={FIT}
        minZoom={0.3}
        maxZoom={1.5}
        // Three id families reach these handlers and only one of them is a
        // stage, so every branch is guarded rather than cast: a feature chip's
        // id handed to `onSelect` would reach `stagePositions()` above as a key
        // that isn't there.
        //
        // The hub is not a stage. Clicking it clears the selection, which is what
        // clicking the pane does -- it is the middle of the overview.
        onNodeClick={(_, node) => {
          if (node.id === HUB_NODE_ID) return onSelect(null)
          if (isFeatureNodeId(node.id)) {
            // The overflow chip is the fan's own switch: it says there is more,
            // and shows it where it already is rather than sending you to
            // another surface. Deliberately leaves the selection alone --
            // opening a drawer is not choosing a stage.
            if (node.id === FEATURE_MORE_ID) setExpanded((x) => !x)
            else onSelect('features')
            return
          }
          if (isStageId(node.id)) onSelect(node.id)
        }}
        onNodeDoubleClick={(_, node) => {
          // The toggle is a control, not a feature: there is nothing behind it
          // to open. Without this it would flip twice (a click fires on each
          // half of a double-click) and then navigate away -- which is the
          // behaviour expanding in place exists to remove.
          if (node.id === FEATURE_MORE_ID) return
          if (isFeatureNodeId(node.id)) return onOpenStage?.('features')
          if (isStageId(node.id)) onOpenStage?.(node.id)
        }}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Lines} gap={24} color="hsl(var(--border) / 0.5)" />
        {/* Bottom-left because `BacktestsPanel` is absolutely positioned at
            top-right in the same box, and the ring leaves the corners empty. */}
        <Controls showInteractive={false} position="bottom-left" />
        <Panel position="bottom-right" className="flex items-center gap-3">
          {PHASE_ORDER.map((phase) => (
            <span key={phase} className="flex items-center gap-1.5">
              <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', PHASE_DOT[phase])} />
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/60">
                {PHASE_LABELS[phase]}
              </span>
            </span>
          ))}
        </Panel>
        <ViewportDirector selected={selected} expanded={open} chipCount={chipCount} />
      </ReactFlow>
    </div>
  )
}
