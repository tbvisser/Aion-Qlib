/**
 * The pipeline as React Flow sees it.
 *
 * The only module in `lib/strategyGraph` allowed to import `@xyflow/react` --
 * the same rule `factorExpr/toFlow.ts` holds, so the graph library stays one
 * swap away and everything else in this directory stays testable as plain data.
 *
 * Stage node ids are stage ids, which are constants. That is what guarantees
 * React Flow never remounts a *card* when a field is edited: the nine ids of
 * the hub and the eight stages are the same, in the same order, for every spec
 * that ever existed.
 *
 * The feature chips are the one part of this canvas that is a function of the
 * spec -- a strategy with three custom columns draws three more nodes than one
 * with none. Their ids are keyed by column name and namespaced `feature:`, so
 * the blast radius of an edit is the one chip that was edited, and no chip id
 * can ever collide with a stage id or with the hub.
 */
import { MarkerType, type Edge, type Node } from '@xyflow/react'

import { handlerColumns, stageGlance, type GlanceContext, type StageGlance } from './glance'
import {
  featureChipPositions, hubPosition, stagePositions, stageSides,
  FEATURE_CHIP_H, FEATURE_CHIP_W, FEATURE_GRID_MAX,
  HUB_H, HUB_W, STAGE_H, STAGE_WIDTHS, type StageSides,
} from './layout'
import { STAGE_ORDER, STAGES, type StageDef, type StageId, type StagePhase } from './stages'
import type { StageBadge, StageStatus } from './stageStatus'
import type { StrategySpec } from '@/lib/api'

export const STAGE_NODE_TYPE = 'stage'
export const HUB_NODE_TYPE = 'hub'
/** Not a `StageId`, and a test pins that it can never become one. */
export const HUB_NODE_ID = 'hub'

export const FEATURE_NODE_TYPE = 'feature'
/**
 * The chip id namespace.
 *
 * A column called `store` is legal (the server only forbids names starting
 * `LABEL`), so chip ids have to live somewhere a stage id cannot reach. The
 * prefix contains a colon, which `StageId` never can.
 */
const FEATURE_NODE_PREFIX = 'feature:'
export const FEATURE_BASE_ID = 'feature:base'
export const FEATURE_MORE_ID = 'feature:more'

/**
 * How many column chips are drawn *while the fan is collapsed* before the rest
 * become a count.
 *
 * The fan holds seven: a base chip, five columns and the overflow chip. A sixth
 * column is drawn rather than collapsed, because "+1 more" in the slot the
 * column itself would occupy tells a reader strictly less than the column does.
 * Expanded, that limit is gone and only the grid's own cap applies.
 */
export const MAX_FEATURE_CHIPS = 5

export function isFeatureNodeId(id: string): boolean {
  return id.startsWith(FEATURE_NODE_PREFIX)
}

/**
 * Whether this strategy has more columns than the collapsed fan can show --
 * which is to say, whether there is anything for expanding to reveal.
 *
 * The canvas gates its expanded flag on this rather than on a column count, so
 * a flag left over from a strategy with twenty columns cannot draw anything
 * after a template swap down to two, and adding a column while expanded cannot
 * slam the fan shut.
 */
export function hasFeatureOverflow(spec: StrategySpec): boolean {
  return (spec.features?.length ?? 0) > MAX_FEATURE_CHIPS + 1
}

/**
 * A type alias rather than an interface on purpose: React Flow constrains node
 * data to `Record<string, unknown>`, and only a type alias picks up the implicit
 * index signature that satisfies it.
 */
export type StageCardData = {
  stage: StageDef
  /** `01`…`08`. The pipeline is ordered, and no node editor usually says so. */
  ordinal: string
  /** What the stage is set to. The headline is the card's bold line. */
  glance: StageGlance
  status: StageStatus
  notes: string[]
  /** Which sides the chain enters and leaves by. A vertical stack has no fixed left/right. */
  sides: StageSides
  width: number
  height: number
}

/** What the eight cards add up to, for the node at the top of the stack. */
export type HubCardData = {
  name: string
  /** Stages with nothing to say at all. The dots carry the other two states. */
  ready: number
  total: number
  blocking: number
  advisory: number
  /** One per stage, in pipeline order, so the hub is a map of the stack. */
  dots: { id: StageId; status: StageStatus }[]
  width: number
  height: number
}

/**
 * One chip hanging off the features card.
 *
 * `kind` rather than three node types: they share a size, a tether and a
 * position in one fan, and the card that draws them is a dozen lines. Three
 * types would be three entries in `nodeTypes` saying the same thing.
 */
export type FeatureChipData = {
  kind: 'base' | 'column' | 'more'
  /** The column's name, the handler's name, or `+3 more`. */
  title: string
  /** The expression, the handler's column count, or nothing. */
  subtitle: string | null
  /** The base chip when the custom columns replace the handler's own. */
  replaced?: boolean
  width: number
  height: number
}

export type StageFlowNode = Node<StageCardData, 'stage'>
export type HubFlowNode = Node<HubCardData, 'hub'>
export type FeatureFlowNode = Node<FeatureChipData, 'feature'>
export type PipelineFlowNode = StageFlowNode | HubFlowNode | FeatureFlowNode

/**
 * The chain's arrowheads.
 *
 * A row was read left to right and needed none; a vertical stack has no such convention.
 * The colour is an inline style on the marker rather than CSS, which is why a
 * variable works in it -- and why every tint needs its own marker: a marker is
 * shared by reference and cannot see the class on the path pointing at it.
 *
 * A healthy edge wears the phase hue of the stage it flows *into* -- the same
 * `--type-*` identity tokens the cards' base rules use -- so the line into a
 * card and the card's own accent can never disagree.
 */
const ARROW = { type: MarkerType.ArrowClosed, width: 12, height: 12, strokeWidth: 1.2 }
const ARROW_BLOCKED = { ...ARROW, color: 'hsl(var(--clay) / 0.7)' }
const ARROW_BY_PHASE: Record<StagePhase, Edge['markerEnd']> = {
  data:    { ...ARROW, color: 'hsl(var(--type-release) / 0.8)' },
  shape:   { ...ARROW, color: 'hsl(var(--type-process) / 0.8)' },
  fit:     { ...ARROW, color: 'hsl(var(--type-notification) / 0.8)' },
  execute: { ...ARROW, color: 'hsl(var(--type-trade) / 0.8)' },
}

export const STAGE_EDGE_TYPE = 'aion-stage-edge'

/** Which way a chain edge curves away from the vertical stack. */
export type StageEdgeCurve = 'left' | 'right'

/**
 * A custom bezier edge is used so the line can curve even though the cards are
 * centred on the same x. The curve alternates left/right down the stack, giving
 * the connection lines the slight S-shape shown in the reference screenshot.
 */
function chainEdge(
  source: StageId,
  target: StageId,
  broken: boolean,
  curve: StageEdgeCurve,
): Edge<{ curve: StageEdgeCurve }> {
  // The *target's* phase: the tint answers "what kind of work does the run
  // flow into here", which is also the accent on the card the arrow points at.
  const phase = STAGES[target].phase
  return {
    id: `${source}->${target}`,
    source,
    sourceHandle: 'out',
    target,
    targetHandle: 'in',
    type: STAGE_EDGE_TYPE,
    className: broken ? 'aion-edge-blocked' : `aion-edge-phase-${phase}`,
    markerEnd: broken ? ARROW_BLOCKED : ARROW_BY_PHASE[phase],
    data: { curve },
  }
}

/**
 * The chain. No arguments and frozen, because the topology is not a function of
 * anything -- a user cannot add, remove or reconnect a stage.
 */
export const STAGE_EDGES: readonly Edge<{ curve: StageEdgeCurve }>[] = Object.freeze(
  STAGE_ORDER.slice(0, -1).map((source, i) => chainEdge(
    source,
    STAGE_ORDER[i + 1],
    false,
    i % 2 === 0 ? 'right' : 'left',
  )),
)

/** `STAGE_EDGES` with the clay dashed class on everything downstream of a blocker. */
export function stageEdges(
  status?: Readonly<Record<StageId, StageBadge>>,
): Edge<{ curve: StageEdgeCurve }>[] {
  if (!status) return STAGE_EDGES.map((e) => ({ ...e }))
  // Once a stage is blocked the run stops there, so every edge after it is
  // drawn broken. The point is that a problem stays visible when the canvas is
  // panned away from the card carrying its badge.
  let broken = false
  return STAGE_ORDER.slice(0, -1).map((source, i) => {
    broken = broken || status[source].status === 'blocked'
    return chainEdge(source, STAGE_ORDER[i + 1], broken, i % 2 === 0 ? 'right' : 'left')
  })
}

/**
 * Hub -> card, one per stage. Membership, not flow.
 *
 * Straight where the chain is curved and faint where the chain is solid, so the
 * two families can never be read as the same thing. Both ends anchor on the
 * node's own *centre* (`core`), which makes a spoke a true radius at every
 * handle with no per-angle maths -- and since edges paint beneath nodes,
 * what is visible is only the segment crossing the gap.
 *
 * Never blocked-styled: a blocker breaks flow, not membership. Frozen and
 * argument-free for the same reason the chain is.
 */
export const HUB_SPOKES: readonly Edge[] = Object.freeze(
  STAGE_ORDER.map((id) => ({
    id: `hub->${id}`,
    source: HUB_NODE_ID,
    sourceHandle: 'core',
    target: id,
    targetHandle: 'core',
    type: 'straight',
    className: 'aion-edge-spoke',
    selectable: false,
    focusable: false,
    interactionWidth: 0,
  })),
)

/**
 * The chips hanging off the features card, in fan order.
 *
 * Nothing at all when a strategy has no custom columns: the features card
 * already prints the handler and its column count, so a lone base chip would
 * restate the card it is tethered to, and the default strategy stays the clean
 * stack it was designed as. The chips appear when there is something the card
 * cannot say -- which columns, by name.
 *
 * The base chip leads because the handler's set is what the custom columns are
 * added to, and the fan reads top to bottom.
 *
 * `expanded` swaps the fan for the grid and drops the five-column limit, so
 * every column gets a chip. The overflow chip stays the same node either way --
 * same id, same kind, only its label turns around -- which is what lets React
 * Flow relabel it instead of remounting, and keeps the roster reading
 * base -> columns -> door in both states.
 */
export function toFeatureNodes(
  spec: StrategySpec,
  expanded = false,
): FeatureFlowNode[] {
  const columns = spec.features ?? []
  if (columns.length === 0) return []

  const replaced = spec.feature_mode === 'replace'
  const base = handlerColumns(spec.handler)
  const chips: { id: string; data: Omit<FeatureChipData, 'width' | 'height'> }[] = [{
    id: FEATURE_BASE_ID,
    data: {
      kind: 'base',
      title: spec.handler,
      // `replace` silently drops every one of the handler's columns, which is
      // the most consequential thing this canvas can fail to mention.
      subtitle: replaced ? 'replaced' : base === null ? 'base set' : `${base} columns`,
      replaced,
    },
  }]

  // A sixth column is drawn; a seventh turns the tail into a count. Expanded,
  // every column is drawn -- up to the grid's own cap, which is the only thing
  // standing between an over-cap draft and a node with no position, since the
  // 32 is enforced by the server and nothing on this side.
  const overflow = columns.length > MAX_FEATURE_CHIPS + 1
  const open = expanded && overflow
  const shown = open
    ? Math.min(columns.length, FEATURE_GRID_MAX - 2)
    : overflow ? MAX_FEATURE_CHIPS : columns.length
  columns.slice(0, shown).forEach((column, i) => {
    chips.push({
      // Keyed by name, so renaming one column remounts one chip. The index is a
      // tiebreak for the duplicate names the server rejects but a draft can hold.
      id: `${FEATURE_NODE_PREFIX}${i}:${column.name}`,
      data: { kind: 'column', title: column.name, subtitle: column.expression },
    })
  })
  if (overflow) {
    chips.push({
      id: FEATURE_MORE_ID,
      data: {
        kind: 'more',
        title: open ? 'show less' : `+${columns.length - shown} more`,
        // The card prints no subtitle for this kind, but it does use it as the
        // tooltip -- so a control that now points two ways can say which.
        subtitle: open ? 'show the first five again' : 'show every column',
      },
    })
  }

  const positions = featureChipPositions(chips.length, open)
  return chips.map((chip, i) => ({
    id: chip.id,
    type: FEATURE_NODE_TYPE,
    position: positions[i],
    width: FEATURE_CHIP_W,
    height: FEATURE_CHIP_H,
    data: { ...chip.data, width: FEATURE_CHIP_W, height: FEATURE_CHIP_H },
  }))
}

/**
 * Chip -> features card. The spoke idea again, one level down: membership, not
 * flow, and never blocked-styled for the same reason.
 *
 * The direction is forced rather than chosen -- the stage card's `core` handle
 * is a target, so the chip's has to be the source.
 */
export function featureEdges(spec: StrategySpec, expanded = false): Edge[] {
  return toFeatureNodes(spec, expanded).map((node) => ({
    id: `${node.id}->features`,
    source: node.id,
    sourceHandle: 'core',
    target: 'features',
    targetHandle: 'core',
    type: 'straight',
    className: 'aion-edge-feature',
    selectable: false,
    focusable: false,
    interactionWidth: 0,
  }))
}

/**
 * Spokes first, so a spoke can never paint over the chain; the chain last, so
 * it paints over everything.
 *
 * `spec` is optional because the chain and the spokes are not a function of it
 * and never were -- a caller that only wants the fixed picture keeps working.
 */
export function pipelineEdges(
  status?: Readonly<Record<StageId, StageBadge>>,
  spec?: StrategySpec,
  expanded = false,
): Edge[] {
  return [
    ...HUB_SPOKES.map((e) => ({ ...e })),
    ...(spec ? featureEdges(spec, expanded) : []),
    ...stageEdges(status),
  ]
}

export function toStageNodes(
  spec: StrategySpec,
  ctx: GlanceContext = {},
  status?: Readonly<Record<StageId, StageBadge>>,
): StageFlowNode[] {
  const positions = stagePositions()
  const sides = stageSides()
  return STAGE_ORDER.map((id, i) => {
    const badge = status?.[id]
    const cardW = STAGE_WIDTHS[id]
    return {
      id,
      type: STAGE_NODE_TYPE,
      position: positions[id],
      // React Flow needs the size up front to lay edges out before first paint;
      // the card reads the same numbers so the two can never disagree.
      width: cardW,
      height: STAGE_H,
      data: {
        stage: STAGES[id],
        ordinal: String(i + 1).padStart(2, '0'),
        glance: stageGlance(id, spec, ctx),
        status: badge?.status ?? 'ok',
        notes: badge?.notes ?? [],
        sides: sides[id],
        width: cardW,
        height: STAGE_H,
      },
    }
  })
}

/**
 * What the eight cards add up to.
 *
 * Everything here is derived from the same badges the cards wear, so the hub can
 * never disagree with the stack below it -- the same reason positions are
 * computed rather than stored.
 */
export function toHubNode(
  spec: StrategySpec,
  status?: Readonly<Record<StageId, StageBadge>>,
): HubFlowNode {
  const dots = STAGE_ORDER.map((id) => ({
    id,
    status: status?.[id]?.status ?? ('ok' as StageStatus),
  }))
  return {
    id: HUB_NODE_ID,
    type: HUB_NODE_TYPE,
    position: hubPosition(),
    width: HUB_W,
    height: HUB_H,
    selectable: false,
    data: {
      name: spec.name,
      ready: dots.filter((d) => d.status === 'ok').length,
      total: dots.length,
      blocking: dots.filter((d) => d.status === 'blocked').length,
      advisory: dots.filter((d) => d.status === 'attention').length,
      dots,
      width: HUB_W,
      height: HUB_H,
    },
  }
}

/**
 * Hub first: it is painted first, so it can never cover a card. Chips last:
 * they overlap nothing, and it keeps `[hub, ...STAGE_ORDER]` the prefix of
 * every node list this canvas has ever drawn.
 */
export function toPipelineNodes(
  spec: StrategySpec,
  ctx: GlanceContext = {},
  status?: Readonly<Record<StageId, StageBadge>>,
  expanded = false,
): PipelineFlowNode[] {
  return [
    toHubNode(spec, status),
    ...toStageNodes(spec, ctx, status),
    ...toFeatureNodes(spec, expanded),
  ]
}
