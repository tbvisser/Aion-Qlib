import { describe, expect, it } from 'vitest'

import { DEFAULT_STRATEGY, type StrategySpec } from '@/lib/api'
import {
  featureChipPositions, featureFanPositions, hubPosition, stagePositions, stageSides,
  FEATURE_CHIP_H, FEATURE_CHIP_W, FEATURE_FAN_MAX, FEATURE_GRID_MAX, STAGE_H, STAGE_WIDTHS,
} from './layout'
import { routeWarnings } from './routeWarning'
import { STAGE_ORDER, isStageId, type StageId } from './stages'
import { stageStatus } from './stageStatus'
import {
  FEATURE_BASE_ID, FEATURE_MORE_ID, FEATURE_NODE_TYPE, HUB_NODE_ID, HUB_NODE_TYPE,
  HUB_SPOKES, MAX_FEATURE_CHIPS, STAGE_EDGE_TYPE, STAGE_EDGES, STAGE_NODE_TYPE,
  featureEdges, hasFeatureOverflow, isFeatureNodeId, pipelineEdges, stageEdges,
  toFeatureNodes, toHubNode, toPipelineNodes, toStageNodes,
} from './toFlow'

const TEST_OVERLAP = 'Test overlaps validation — results would be optimistic.'

/** A spec with `n` custom columns, named so a test can point at one. */
function withFeatures(n: number, mode: 'extend' | 'replace' = 'extend'): StrategySpec {
  return {
    ...DEFAULT_STRATEGY,
    feature_mode: mode,
    features: Array.from({ length: n }, (_, i) => ({
      name: `COL${i + 1}`,
      expression: `Ref($close, ${i + 1})/$close - 1`,
    })),
  }
}

describe('STAGE_EDGES', () => {
  it('is a chain: n-1 edges, each joining consecutive stages', () => {
    expect(STAGE_EDGES).toHaveLength(STAGE_ORDER.length - 1)
    STAGE_EDGES.forEach((edge, i) => {
      expect(edge.source).toBe(STAGE_ORDER[i])
      expect(edge.target).toBe(STAGE_ORDER[i + 1])
    })
  })

  it('has exactly one stage with nothing before it and one with nothing after', () => {
    const targets = new Set(STAGE_EDGES.map((e) => e.target))
    const sources = new Set(STAGE_EDGES.map((e) => e.source))
    expect(STAGE_ORDER.filter((id) => !targets.has(id))).toEqual([STAGE_ORDER[0]])
    expect(STAGE_ORDER.filter((id) => !sources.has(id)))
      .toEqual([STAGE_ORDER[STAGE_ORDER.length - 1]])
  })

  it('is frozen — the topology is not a function of anything', () => {
    expect(Object.isFrozen(STAGE_EDGES)).toBe(true)
  })
})

describe('stageEdges', () => {
  it('tints every healthy edge with the phase of the stage it flows into', () => {
    // The same wearer-side rule as the cards' base rules: the tint belongs to
    // the *target*, so the line into a card always matches the card's accent.
    expect(stageEdges(stageStatus([])).map((e) => e.className)).toEqual([
      'aion-edge-phase-data',    // -> universe
      'aion-edge-phase-shape',   // -> features
      'aion-edge-phase-shape',   // -> periods
      'aion-edge-phase-fit',     // -> learner
      'aion-edge-phase-execute', // -> portfolio
      'aion-edge-phase-execute', // -> costs
    ])
  })

  it('breaks every edge downstream of a blocked stage, and none before it', () => {
    // `periods` is index 3, so the store->universe and universe->features edges
    // stay whole and everything from periods onward is drawn broken.
    const edges = stageEdges(stageStatus(routeWarnings([TEST_OVERLAP])))
    const broken = edges.map((e) => e.className === 'aion-edge-blocked')
    expect(broken).toEqual([false, false, false, true, true, true])
  })

  it('is tinted, never blocked, when no status is supplied at all', () => {
    expect(stageEdges().every((e) => e.className?.startsWith('aion-edge-phase-'))).toBe(true)
  })

  it('points the arrow the way the run goes, and clays it past a blocker', () => {
    // A row was read left to right and needed no arrowhead; a vertical stack has
    // no such convention. CSS cannot recolour these: a marker is shared by reference and
    // cannot see the class on the path pointing at it -- which is why a healthy
    // arrowhead carries its phase token inline and a broken one carries clay.
    const colours = stageEdges(stageStatus(routeWarnings([TEST_OVERLAP])))
      .map((e) => (e.markerEnd as { color: string }).color)
    expect(colours).toEqual([
      'hsl(var(--type-release) / 0.8)',   // -> universe, healthy
      'hsl(var(--type-process) / 0.8)',   // -> features, healthy
      'hsl(var(--type-process) / 0.8)',   // -> periods, healthy
      'hsl(var(--clay) / 0.7)', 'hsl(var(--clay) / 0.7)', 'hsl(var(--clay) / 0.7)',
    ])
  })
})

describe('HUB_SPOKES', () => {
  it('tethers every stage to the hub, and nothing else', () => {
    expect(HUB_SPOKES).toHaveLength(STAGE_ORDER.length)
    expect(HUB_SPOKES.map((e) => e.target)).toEqual([...STAGE_ORDER])
    expect(HUB_SPOKES.every((e) => e.source === HUB_NODE_ID)).toBe(true)
  })

  it('draws membership straight and flow curved, so the two never read alike', () => {
    expect(HUB_SPOKES.every((e) => e.type === 'straight')).toBe(true)
    expect(stageEdges().every((e) => e.type === STAGE_EDGE_TYPE)).toBe(true)
  })

  it('anchors both ends on node centres', () => {
    expect(HUB_SPOKES.every((e) => e.sourceHandle === 'core' && e.targetHandle === 'core'))
      .toBe(true)
  })

  it('is inert: nothing about membership is hoverable or clickable', () => {
    expect(HUB_SPOKES.every((e) => e.selectable === false && e.interactionWidth === 0))
      .toBe(true)
  })

  it('never wears the blocked class — a blocker breaks flow, not membership', () => {
    const spokes = pipelineEdges(stageStatus(routeWarnings([TEST_OVERLAP])))
      .filter((e) => e.source === HUB_NODE_ID)
    expect(spokes).toHaveLength(STAGE_ORDER.length)
    expect(spokes.every((e) => e.className === 'aion-edge-spoke')).toBe(true)
  })

  it('is frozen — a user cannot join or leave the stack', () => {
    expect(Object.isFrozen(HUB_SPOKES)).toBe(true)
  })
})

describe('pipelineEdges', () => {
  it('puts the spokes first, so a spoke can never paint over the chain', () => {
    const edges = pipelineEdges(stageStatus([]))
    expect(edges.slice(0, STAGE_ORDER.length).every((e) => e.type === 'straight')).toBe(true)
    expect(edges.slice(STAGE_ORDER.length).every((e) => e.type === STAGE_EDGE_TYPE)).toBe(true)
    expect(edges).toHaveLength(STAGE_ORDER.length + (STAGE_ORDER.length - 1))
  })
})

describe('toStageNodes', () => {
  it('emits one node per stage, in pipeline order', () => {
    const nodes = toStageNodes(DEFAULT_STRATEGY)
    expect(nodes.map((n) => n.id)).toEqual([...STAGE_ORDER])
    expect(nodes.every((n) => n.type === STAGE_NODE_TYPE)).toBe(true)
  })

  /**
   * The guarantee React Flow never remounts a card mid-edit. Node ids are stage
   * ids, which are constants, so no spec can produce a different node list —
   * and a remount would drop the selection and restart every transition.
   */
  it('produces the same node ids for any two specs', () => {
    const a = toStageNodes(DEFAULT_STRATEGY)
    const b = toStageNodes({
      ...DEFAULT_STRATEGY,
      data_store: 'crypto_365', handler: 'Alpha360', topk: 1,
      features: [{ name: 'MOM5', expression: '$close' }], feature_mode: 'replace',
    })
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id))
  })

  it('takes every position from the layout and nowhere else', () => {
    const at = stagePositions()
    for (const node of toStageNodes(DEFAULT_STRATEGY)) {
      expect(node.position).toEqual(at[node.id as keyof typeof at])
    }
  })

  it('sizes cards from the layout constants, so edges and cards cannot disagree', () => {
    for (const node of toStageNodes(DEFAULT_STRATEGY)) {
      const expectedW = STAGE_WIDTHS[node.id as keyof typeof STAGE_WIDTHS]
      expect(node.width).toBe(expectedW)
      expect(node.height).toBe(STAGE_H)
      expect(node.data.width).toBe(expectedW)
      expect(node.data.height).toBe(STAGE_H)
    }
  })

  it('numbers the stages from 01', () => {
    expect(toStageNodes(DEFAULT_STRATEGY).map((n) => n.data.ordinal))
      .toEqual(['01', '02', '03', '04', '05', '06', '07'])
  })

  it('defaults every card to ok when no status is supplied', () => {
    const nodes = toStageNodes(DEFAULT_STRATEGY)
    expect(nodes.every((n) => n.data.status === 'ok' && n.data.notes.length === 0)).toBe(true)
  })

  it('carries the badge and its notes onto the right card', () => {
    const nodes = toStageNodes(DEFAULT_STRATEGY, {}, stageStatus(routeWarnings([TEST_OVERLAP])))
    const periods = nodes.find((n) => n.id === 'periods')
    expect(periods?.data.status).toBe('blocked')
    expect(periods?.data.notes).toEqual([TEST_OVERLAP])
    expect(nodes.find((n) => n.id === 'costs')?.data.status).toBe('ok')
  })

  it('gives every card a headline to print', () => {
    for (const node of toStageNodes(DEFAULT_STRATEGY)) {
      expect(node.data.glance.headline).toBeTruthy()
    }
  })

  it('gives each card the sides its chain actually enters and leaves by', () => {
    const sides = stageSides()
    for (const node of toStageNodes(DEFAULT_STRATEGY)) {
      expect(node.data.sides).toEqual(sides[node.id as StageId])
    }
  })
})

describe('toHubNode', () => {
  it('sits above the stage stack', () => {
    expect(toHubNode(DEFAULT_STRATEGY).position).toEqual(hubPosition())
    expect(toHubNode(DEFAULT_STRATEGY).type).toBe(HUB_NODE_TYPE)
  })

  it('is not a stage: its id can never collide with one', () => {
    expect(STAGE_ORDER).not.toContain(HUB_NODE_ID as StageId)
  })

  /**
   * The hub is the one thing on this canvas that says something about the whole
   * strategy, so it is the one thing that could contradict it. It counts the
   * cards' own badges rather than re-deriving anything.
   */
  it('cannot disagree with the stack: it counts the cards\' own badges', () => {
    const status = stageStatus(routeWarnings([TEST_OVERLAP]))
    const hub = toHubNode(DEFAULT_STRATEGY, status)
    const cards = toStageNodes(DEFAULT_STRATEGY, {}, status)
    expect(hub.data.total).toBe(STAGE_ORDER.length)
    expect(hub.data.dots.map((d) => d.id)).toEqual([...STAGE_ORDER])
    expect(hub.data.dots.map((d) => d.status)).toEqual(cards.map((n) => n.data.status))
    expect(hub.data.blocking).toBe(1)
    expect(hub.data.ready + hub.data.advisory + hub.data.blocking).toBe(hub.data.total)
  })

  it('is all ready when nothing is wrong', () => {
    const hub = toHubNode(DEFAULT_STRATEGY, stageStatus([]))
    expect(hub.data.ready).toBe(STAGE_ORDER.length)
    expect(hub.data.blocking).toBe(0)
  })

  it('carries the strategy name — the only place the canvas says it', () => {
    expect(toHubNode({ ...DEFAULT_STRATEGY, name: 'Momentum v3' }).data.name)
      .toBe('Momentum v3')
  })
})

describe('toPipelineNodes', () => {
  it('is the hub first, then the seven cards, so nothing paints over a card', () => {
    expect(toPipelineNodes(DEFAULT_STRATEGY).map((n) => n.id))
      .toEqual([HUB_NODE_ID, ...STAGE_ORDER])
  })

  it('keeps the hub and the seven cards as the prefix, whatever else is drawn', () => {
    expect(toPipelineNodes(withFeatures(3)).slice(0, 8).map((n) => n.id))
      .toEqual([HUB_NODE_ID, ...STAGE_ORDER])
    // Including when the fan is opened to its widest -- the prefix is the thing
    // a careless append would break.
    const expanded = toPipelineNodes(withFeatures(32), {}, undefined, true)
    expect(expanded).toHaveLength(8 + FEATURE_GRID_MAX)
    expect(expanded.slice(0, 8).map((n) => n.id)).toEqual([HUB_NODE_ID, ...STAGE_ORDER])
  })
})

describe('toFeatureNodes', () => {
  /**
   * The default picture is the one this canvas was designed as, and a strategy
   * with no custom columns has to keep drawing it: the features card already
   * prints the handler and its count, so a lone base chip would restate it.
   */
  it('draws nothing when a strategy has no custom columns', () => {
    expect(toFeatureNodes(DEFAULT_STRATEGY)).toEqual([])
    expect(toPipelineNodes(DEFAULT_STRATEGY)).toHaveLength(8)
    expect(pipelineEdges(stageStatus([]), DEFAULT_STRATEGY)).toHaveLength(13)
  })

  it('leads with the handler set, then the columns added to it', () => {
    const chips = toFeatureNodes(withFeatures(3))
    expect(chips.map((n) => n.data.kind)).toEqual(['base', 'column', 'column', 'column'])
    expect(chips[0].id).toBe(FEATURE_BASE_ID)
    expect(chips[0].data.title).toBe('Alpha158')
    expect(chips[0].data.subtitle).toBe('158 columns')
    expect(chips[0].data.replaced).toBe(false)
    expect(chips.slice(1).map((n) => n.data.title)).toEqual(['COL1', 'COL2', 'COL3'])
    expect(chips[1].data.subtitle).toBe('Ref($close, 1)/$close - 1')
  })

  it('says so when the custom columns replace the handler\'s own', () => {
    // The one thing this canvas could otherwise fail to mention: `replace`
    // drops all 158 columns and nothing else on screen would say it.
    const base = toFeatureNodes(withFeatures(2, 'replace'))[0]
    expect(base.data.replaced).toBe(true)
    expect(base.data.subtitle).toBe('replaced')
    expect(base.data.title).toBe('Alpha158')
  })

  it('draws a sixth column rather than collapsing it into a count', () => {
    // "+1 more" in the slot the column itself would take says strictly less.
    const chips = toFeatureNodes(withFeatures(MAX_FEATURE_CHIPS + 1))
    expect(chips).toHaveLength(MAX_FEATURE_CHIPS + 2)
    expect(chips.some((n) => n.id === FEATURE_MORE_ID)).toBe(false)
  })

  it('turns the tail into a count once the fan is full', () => {
    const chips = toFeatureNodes(withFeatures(MAX_FEATURE_CHIPS + 2))
    expect(chips).toHaveLength(FEATURE_FAN_MAX)
    expect(chips[chips.length - 1].id).toBe(FEATURE_MORE_ID)
    expect(chips[chips.length - 1].data.title).toBe('+2 more')
  })

  it('never outgrows the fan, even at the server\'s cap of 32 columns', () => {
    const chips = toFeatureNodes(withFeatures(32))
    expect(chips).toHaveLength(FEATURE_FAN_MAX)
    expect(chips[chips.length - 1].data.title).toBe('+27 more')
  })

  it('takes every position and size from the layout and nowhere else', () => {
    const chips = toFeatureNodes(withFeatures(4))
    const at = featureFanPositions(chips.length)
    chips.forEach((chip, i) => {
      expect(chip.position).toEqual(at[i])
      expect(chip.width).toBe(FEATURE_CHIP_W)
      expect(chip.height).toBe(FEATURE_CHIP_H)
      expect(chip.data.width).toBe(FEATURE_CHIP_W)
      expect(chip.data.height).toBe(FEATURE_CHIP_H)
      expect(chip.type).toBe(FEATURE_NODE_TYPE)
    })
  })

  /**
   * A column may legally be called `store`. Chip ids therefore have to live
   * somewhere a stage id cannot reach, or a click handler resolves a chip to a
   * stage -- which is exactly the bug the guards in `PipelineCanvas` prevent.
   */
  it('keeps chip ids out of the stages\' namespace, both ways', () => {
    const chips = toFeatureNodes({
      ...withFeatures(0),
      features: [{ name: 'store', expression: '$close' }],
    })
    for (const chip of [...chips, ...toFeatureNodes(withFeatures(9))]) {
      expect(isFeatureNodeId(chip.id)).toBe(true)
      expect(isStageId(chip.id)).toBe(false)
      expect(chip.id).not.toBe(HUB_NODE_ID)
    }
    for (const id of STAGE_ORDER) {
      expect(isFeatureNodeId(id)).toBe(false)
      expect(isStageId(id)).toBe(true)
    }
    expect(isFeatureNodeId(HUB_NODE_ID)).toBe(false)
    expect(isStageId(HUB_NODE_ID)).toBe(false)
  })
})

describe('hasFeatureOverflow', () => {
  it('is true exactly when there is something left to reveal', () => {
    expect(hasFeatureOverflow(DEFAULT_STRATEGY)).toBe(false)
    expect(hasFeatureOverflow(withFeatures(MAX_FEATURE_CHIPS))).toBe(false)
    // Six is the last count the collapsed fan draws in full.
    expect(hasFeatureOverflow(withFeatures(MAX_FEATURE_CHIPS + 1))).toBe(false)
    expect(hasFeatureOverflow(withFeatures(MAX_FEATURE_CHIPS + 2))).toBe(true)
    expect(hasFeatureOverflow(withFeatures(32))).toBe(true)
  })
})

describe('toFeatureNodes, expanded', () => {
  /**
   * The reset guarantee, asserted where it is actually enforced. The canvas
   * gates its flag on `hasFeatureOverflow`, but even a flag that slipped
   * through cannot draw a different picture when there is nothing to expand.
   */
  it('is a no-op when there is nothing to expand', () => {
    for (const n of [0, 1, 3, 5, MAX_FEATURE_CHIPS + 1]) {
      expect(toFeatureNodes(withFeatures(n), true))
        .toEqual(toFeatureNodes(withFeatures(n)))
    }
  })

  it('draws every column once expanded, plus the base chip and the toggle', () => {
    const chips = toFeatureNodes(withFeatures(32), true)
    expect(chips).toHaveLength(FEATURE_GRID_MAX)
    expect(chips[0].id).toBe(FEATURE_BASE_ID)
    expect(chips[chips.length - 1].id).toBe(FEATURE_MORE_ID)
    expect(chips.map((n) => n.data.kind))
      .toEqual(['base', ...Array(32).fill('column'), 'more'])
    expect(new Set(chips.map((n) => n.id)).size).toBe(chips.length)
  })

  it('turns the same chip around rather than minting a second one', () => {
    // Same id and same kind in both states, so React Flow relabels it instead
    // of remounting, and the click handler stays one id comparison.
    const collapsed = toFeatureNodes(withFeatures(32))
    const expanded = toFeatureNodes(withFeatures(32), true)
    const before = collapsed[collapsed.length - 1]
    const after = expanded[expanded.length - 1]
    expect(before.id).toBe(after.id)
    expect(before.data.kind).toBe(after.data.kind)
    expect(before.data.title).toBe('+27 more')
    expect(after.data.title).toBe('show less')
  })

  it('leaves everything already on screen exactly where it was', () => {
    const collapsed = toFeatureNodes(withFeatures(32))
    const expanded = toFeatureNodes(withFeatures(32), true)
    // The base chip and the five drawn columns keep their ids across the
    // toggle, so expanding mounts only chips that are genuinely new.
    expect(expanded.slice(0, MAX_FEATURE_CHIPS + 1).map((n) => n.id))
      .toEqual(collapsed.slice(0, MAX_FEATURE_CHIPS + 1).map((n) => n.id))
  })

  it('takes expanded positions from the grid and nowhere else', () => {
    const chips = toFeatureNodes(withFeatures(20), true)
    const at = featureChipPositions(chips.length, true)
    chips.forEach((chip, i) => {
      expect(chip.position).toEqual(at[i])
      expect(chip.width).toBe(FEATURE_CHIP_W)
      expect(chip.height).toBe(FEATURE_CHIP_H)
    })
  })

  /**
   * The 32 is the server's cap and nothing enforces it on this side, so a draft
   * can hold more columns than the grid has room for. Every chip must still get
   * a position -- a node without one is a React Flow crash, not a layout bug.
   */
  it('cannot mint a chip without a position, however long the draft', () => {
    const chips = toFeatureNodes(withFeatures(40), true)
    expect(chips).toHaveLength(FEATURE_GRID_MAX)
    for (const chip of chips) {
      expect(chip.position).toBeDefined()
      expect(Number.isFinite(chip.position.x)).toBe(true)
      expect(Number.isFinite(chip.position.y)).toBe(true)
    }
  })
})

describe('featureEdges', () => {
  it('tethers every chip to the features card, and nothing else', () => {
    const edges = featureEdges(withFeatures(3))
    expect(edges).toHaveLength(4)
    expect(edges.every((e) => e.target === 'features')).toBe(true)
    expect(edges.map((e) => e.source))
      .toEqual(toFeatureNodes(withFeatures(3)).map((n) => n.id))
  })

  it('anchors both ends on node centres, like the hub\'s spokes', () => {
    // The direction is forced, not chosen: the card's `core` handle is a
    // target, so the chip's has to be the source.
    expect(featureEdges(withFeatures(2)).every(
      (e) => e.sourceHandle === 'core' && e.targetHandle === 'core',
    )).toBe(true)
  })

  it('draws membership straight and inert, never as flow', () => {
    expect(featureEdges(withFeatures(2)).every(
      (e) => e.type === 'straight'
        && e.className === 'aion-edge-feature'
        && e.selectable === false
        && e.interactionWidth === 0,
    )).toBe(true)
  })

  it('is nothing at all when there are no custom columns', () => {
    expect(featureEdges(DEFAULT_STRATEGY)).toEqual([])
  })
})

describe('pipelineEdges with a feature set', () => {
  it('is spokes, then tethers, then the chain — so the chain paints on top', () => {
    const edges = pipelineEdges(stageStatus([]), withFeatures(3))
    expect(edges).toHaveLength(STAGE_ORDER.length + 4 + (STAGE_ORDER.length - 1))
    expect(edges.slice(0, STAGE_ORDER.length).every((e) => e.className === 'aion-edge-spoke'))
      .toBe(true)
    expect(edges.slice(STAGE_ORDER.length, STAGE_ORDER.length + 4)
      .every((e) => e.className === 'aion-edge-feature')).toBe(true)
    expect(edges.slice(STAGE_ORDER.length + 4).every((e) => e.type === STAGE_EDGE_TYPE)).toBe(true)
  })

  it('draws the fixed picture when it is not given a spec', () => {
    expect(pipelineEdges(stageStatus([]))).toHaveLength(13)
  })

  it('never blocks a tether — a blocker breaks flow, not membership', () => {
    const edges = pipelineEdges(stageStatus(routeWarnings([TEST_OVERLAP])), withFeatures(3))
      .filter((e) => e.className === 'aion-edge-feature')
    expect(edges).toHaveLength(4)
  })

  it('tethers every chip the expanded grid draws, and no more', () => {
    // Edge count === chip count is true by construction in both states, since
    // `featureEdges` maps over the same roster. Restated here because it is the
    // thing that would silently break if the two ever stopped sharing it.
    const chips = toFeatureNodes(withFeatures(32), true)
    const tethers = featureEdges(withFeatures(32), true)
    expect(tethers).toHaveLength(FEATURE_GRID_MAX)
    expect(tethers.map((e) => e.source)).toEqual(chips.map((n) => n.id))
    expect(tethers.every((e) => e.target === 'features')).toBe(true)
    expect(tethers.every((e) => e.className === 'aion-edge-feature')).toBe(true)
  })

  it('is spokes, then 34 tethers, then the chain, when expanded', () => {
    const edges = pipelineEdges(stageStatus([]), withFeatures(32), true)
    expect(edges).toHaveLength(STAGE_ORDER.length + FEATURE_GRID_MAX + (STAGE_ORDER.length - 1))
    expect(edges.slice(0, STAGE_ORDER.length).every((e) => e.className === 'aion-edge-spoke'))
      .toBe(true)
    expect(edges.slice(STAGE_ORDER.length, STAGE_ORDER.length + FEATURE_GRID_MAX)
      .every((e) => e.className === 'aion-edge-feature')).toBe(true)
    expect(edges.slice(STAGE_ORDER.length + FEATURE_GRID_MAX)
      .every((e) => e.type === STAGE_EDGE_TYPE)).toBe(true)
  })

  it('never blocks a tether when expanded either', () => {
    const edges = pipelineEdges(stageStatus(routeWarnings([TEST_OVERLAP])), withFeatures(32), true)
      .filter((e) => e.className === 'aion-edge-feature')
    expect(edges).toHaveLength(FEATURE_GRID_MAX)
  })
})
