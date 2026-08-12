import { describe, expect, it } from 'vitest'

import { DEFAULT_STRATEGY } from '@/lib/api'
import { stagePositions, STAGE_H, STAGE_W } from './layout'
import { routeWarnings } from './routeWarning'
import { STAGE_ORDER } from './stages'
import { stageStatus } from './stageStatus'
import { STAGE_EDGES, STAGE_NODE_TYPE, stageEdges, toStageNodes } from './toFlow'

const TEST_OVERLAP = 'Test overlaps validation — results would be optimistic.'

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
  it('leaves every edge plain when nothing blocks', () => {
    expect(stageEdges(stageStatus([])).every((e) => e.className === undefined)).toBe(true)
  })

  it('breaks every edge downstream of a blocked stage, and none before it', () => {
    // `periods` is index 3, so the store->universe and universe->features edges
    // stay whole and everything from periods onward is drawn broken.
    const edges = stageEdges(stageStatus(routeWarnings([TEST_OVERLAP])))
    const broken = edges.map((e) => e.className === 'aion-edge-blocked')
    expect(broken).toEqual([false, false, false, true, true, true])
  })

  it('is plain when no status is supplied at all', () => {
    expect(stageEdges().every((e) => e.className === undefined)).toBe(true)
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
      expect(node.width).toBe(STAGE_W)
      expect(node.height).toBe(STAGE_H)
      expect(node.data.width).toBe(STAGE_W)
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
})
