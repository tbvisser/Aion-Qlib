/**
 * The pipeline as React Flow sees it.
 *
 * The only module in `lib/strategyGraph` allowed to import `@xyflow/react` --
 * the same rule `factorExpr/toFlow.ts` holds, so the graph library stays one
 * swap away and everything else in this directory stays testable as plain data.
 *
 * Node ids are stage ids, which are constants. That is what guarantees React
 * Flow never remounts a card when a field is edited: the node list has the same
 * seven ids in the same order for every spec that ever existed.
 */
import type { Edge, Node } from '@xyflow/react'

import { stageGlance, type GlanceContext, type StageGlance } from './glance'
import { stagePositions, STAGE_H, STAGE_W } from './layout'
import { STAGE_ORDER, STAGES, type StageDef, type StageId } from './stages'
import type { StageBadge, StageStatus } from './stageStatus'
import type { StrategySpec } from '@/lib/api'

export const STAGE_NODE_TYPE = 'stage'

/**
 * A type alias rather than an interface on purpose: React Flow constrains node
 * data to `Record<string, unknown>`, and only a type alias picks up the implicit
 * index signature that satisfies it.
 */
export type StageCardData = {
  stage: StageDef
  /** `01`…`07`. The pipeline is ordered, and no node editor usually says so. */
  ordinal: string
  /** What the stage is set to. The headline is the card's bold line. */
  glance: StageGlance
  status: StageStatus
  notes: string[]
  width: number
  height: number
}

export type StageFlowNode = Node<StageCardData, 'stage'>

/**
 * The chain. No arguments and frozen, because the topology is not a function of
 * anything -- a user cannot add, remove or reconnect a stage.
 */
export const STAGE_EDGES: readonly Edge[] = Object.freeze(
  STAGE_ORDER.slice(0, -1).map((source, i) => {
    const target = STAGE_ORDER[i + 1]
    return {
      id: `${source}->${target}`,
      source,
      sourceHandle: 'out',
      target,
      targetHandle: 'in',
    }
  }),
)

/** `STAGE_EDGES` with the clay dashed class on everything downstream of a blocker. */
export function stageEdges(
  status?: Readonly<Record<StageId, StageBadge>>,
): Edge[] {
  if (!status) return STAGE_EDGES.map((e) => ({ ...e }))
  // Once a stage is blocked the run stops there, so every edge after it is
  // drawn broken. The point is that a problem stays visible when the canvas is
  // panned away from the card carrying its badge.
  let broken = false
  return STAGE_ORDER.slice(0, -1).map((source, i) => {
    broken = broken || status[source].status === 'blocked'
    const target = STAGE_ORDER[i + 1]
    return {
      id: `${source}->${target}`,
      source,
      sourceHandle: 'out',
      target,
      targetHandle: 'in',
      className: broken ? 'aion-edge-blocked' : undefined,
    }
  })
}

export function toStageNodes(
  spec: StrategySpec,
  ctx: GlanceContext = {},
  status?: Readonly<Record<StageId, StageBadge>>,
): StageFlowNode[] {
  const positions = stagePositions()
  return STAGE_ORDER.map((id, i) => {
    const badge = status?.[id]
    return {
      id,
      type: STAGE_NODE_TYPE,
      position: positions[id],
      // React Flow needs the size up front to lay edges out before first paint;
      // the card reads the same numbers so the two can never disagree.
      width: STAGE_W,
      height: STAGE_H,
      data: {
        stage: STAGES[id],
        ordinal: String(i + 1).padStart(2, '0'),
        glance: stageGlance(id, spec, ctx),
        status: badge?.status ?? 'ok',
        notes: badge?.notes ?? [],
        width: STAGE_W,
        height: STAGE_H,
      },
    }
  })
}
