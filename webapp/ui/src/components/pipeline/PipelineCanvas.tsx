/**
 * The strategy, drawn as its seven stages.
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
import { useEffect, useMemo } from 'react'
import {
  Background, BackgroundVariant, Controls, ReactFlow, useReactFlow,
  type NodeTypes,
} from '@xyflow/react'

import { StageNodeCard } from './StageNodeCard'
import type { StrategySpec } from '@/lib/api'
import type { GlanceContext } from '@/lib/strategyGraph/glance'
import { STAGE_H, STAGE_W, stagePositions } from '@/lib/strategyGraph/layout'
import type { StageId } from '@/lib/strategyGraph/stages'
import type { StageBadge } from '@/lib/strategyGraph/stageStatus'
import { STAGE_NODE_TYPE, stageEdges, toStageNodes } from '@/lib/strategyGraph/toFlow'

import '@xyflow/react/dist/base.css'
import '@/styles/reactflow.css'

/** Must be referentially stable or React Flow remounts every node each render. */
const nodeTypes: NodeTypes = { [STAGE_NODE_TYPE]: StageNodeCard }

/**
 * Pans the selected stage into view without changing the zoom.
 *
 * Deliberately not `fitView`. Seven cards at 308px pitch is ~2,100px wide, and
 * fitting that into a pane zooms to about 0.6 -- where a 10px mono eyebrow is
 * unreadable. The picture is always the same shape, so an overview teaches
 * nothing after the first second; what a reader always wants is to *read* a
 * card. `<Controls>` still offers fit-to-view for the one time they don't.
 */
function PanToSelected({ selected }: { selected: StageId | null }) {
  const { setCenter, getZoom } = useReactFlow()
  useEffect(() => {
    if (!selected) return
    const at = stagePositions()[selected]
    void setCenter(at.x + STAGE_W / 2, at.y + STAGE_H / 2, {
      zoom: getZoom(), duration: 220,
    })
  }, [selected, setCenter, getZoom])
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
  const nodes = useMemo(
    () => toStageNodes(spec, glance, status).map((n) => ({ ...n, selected: n.id === selected })),
    [spec, glance, status, selected],
  )
  const edges = useMemo(() => stageEdges(status), [status])

  return (
    <div className="relative min-h-0 min-w-0 flex-1" data-testid="pipeline-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        // The whole picture is derived. Position changes have nowhere to go and
        // selection is the page's state, so React Flow is told about neither.
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        defaultViewport={{ x: 32, y: 32, zoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
        onNodeClick={(_, node) => onSelect(node.id as StageId)}
        onNodeDoubleClick={(_, node) => onOpenStage?.(node.id as StageId)}
        onPaneClick={() => onSelect(null)}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Lines} gap={24} color="hsl(var(--border) / 0.5)" />
        <Controls showInteractive={false} position="top-right" />
        <PanToSelected selected={selected} />
      </ReactFlow>
    </div>
  )
}
