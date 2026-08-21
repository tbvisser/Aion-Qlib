import { describe, expect, it } from 'vitest'

import type { KeycardSpec } from '@/lib/api'
import {
  KEYCARD_EDGE_TYPE,
  KEYCARD_NODE_TYPE,
  addNextPosition,
  fromFlow,
  layoutTree,
  routeDefects,
  toFlowEdges,
  toFlowNodes,
} from './keycardFlow'

function makeKeycardSpec(): KeycardSpec {
  const storeId = 'store-1'
  const universeId = 'universe-1'
  return {
    name: 'Test keycard',
    description: '',
    tags: [],
    is_template: false,
    template_family: null,
    windows: {
      train_start: '2010-01-04',
      train_end: '2019-12-31',
      valid_start: '2020-01-01',
      valid_end: '2021-12-31',
      test_start: '2022-01-01',
      test_end: '2026-08-07',
    },
    nodes: [
      { id: storeId, type: 'data_store', position: { x: 0, y: 0 }, config: { store: 'us' }, notes: '' },
      { id: universeId, type: 'universe', position: { x: 0, y: 100 }, config: {}, notes: '' },
    ],
    edges: [
      { id: 'e1', source: storeId, source_port: 'data', target: universeId, target_port: 'data' },
    ],
  }
}

function makeMetaByType() {
  return new Map([
    ['data_store', {
      id: 'data_store',
      category: 'data',
      label: 'Data Store',
      icon: 'database',
      description: '',
      ports: [{ id: 'data', label: 'Data', type: 'data' as const, direction: 'out' as const, required: true }],
      config_schema: {},
    }],
    ['universe', {
      id: 'universe',
      category: 'data',
      label: 'Universe',
      icon: 'globe',
      description: '',
      ports: [
        { id: 'data', label: 'Data', type: 'data' as const, direction: 'in' as const, required: true },
        { id: 'data', label: 'Data', type: 'data' as const, direction: 'out' as const, required: true },
      ],
      config_schema: {},
    }],
  ])
}

describe('toFlowNodes', () => {
  it('produces one React Flow node per keycard node', () => {
    const keycard = makeKeycardSpec()
    const nodes = toFlowNodes(keycard, makeMetaByType())
    expect(nodes).toHaveLength(keycard.nodes.length)
    nodes.forEach((n, i) => {
      expect(n.id).toBe(keycard.nodes[i].id)
      expect(n.position).toEqual(keycard.nodes[i].position)
      expect(n.data.keycardNode).toEqual(keycard.nodes[i])
    })
  })

  it('places newly added downstream nodes to the right with vertical branching', () => {
    const keycard = makeKeycardSpec()
    const meta = makeMetaByType()
    const sourceNode = keycard.nodes[0]
    const pos0 = addNextPosition(sourceNode, 'data', meta, 0)
    const pos1 = addNextPosition(sourceNode, 'data', meta, 1)
    expect(pos0.x).toBe(160 + 180)
    expect(pos0.y).toBe(0)
    expect(pos1.x).toBe(pos0.x)
    expect(pos1.y).toBeGreaterThan(pos0.y)
  })

  it('marks the selected node', () => {
    const keycard = makeKeycardSpec()
    const nodes = toFlowNodes(keycard, makeMetaByType(), [], keycard.nodes[0].id)
    expect(nodes[0].selected).toBe(true)
    expect(nodes[1].selected).toBe(false)
  })

  it('attaches metadata by node type', () => {
    const keycard = makeKeycardSpec()
    const nodes = toFlowNodes(keycard, makeMetaByType())
    expect(nodes[0].data.meta?.label).toBe('Data Store')
    expect(nodes[1].data.meta?.label).toBe('Universe')
  })

  it('propagates connection highlight state for handle highlighting', () => {
    const keycard = makeKeycardSpec()
    const nodes = toFlowNodes(keycard, makeMetaByType(), [], null, undefined, undefined, undefined, undefined, 'data', 'target')
    nodes.forEach((n) => {
      expect(n.data.connectingPortType).toBe('data')
      expect(n.data.seekingHandle).toBe('target')
    })
  })

  it('defaults connection highlight state to null', () => {
    const keycard = makeKeycardSpec()
    const nodes = toFlowNodes(keycard, makeMetaByType())
    nodes.forEach((n) => {
      expect(n.data.connectingPortType).toBeNull()
      expect(n.data.seekingHandle).toBeNull()
    })
  })
})

describe('toFlowEdges', () => {
  it('produces one React Flow edge per keycard edge with typed handles', () => {
    const keycard = makeKeycardSpec()
    const meta = makeMetaByType()
    const edges = toFlowEdges(keycard, meta)
    expect(edges).toHaveLength(keycard.edges.length)
    edges.forEach((e, i) => {
      expect(e.id).toBe(keycard.edges[i].id)
      expect(e.type).toBe(KEYCARD_EDGE_TYPE)
      expect(e.sourceHandle).toBe(keycard.edges[i].source_port)
      expect(e.targetHandle).toBe(keycard.edges[i].target_port)
    })
  })

  it('adds a coloured stroke and arrow marker matching the source port type', () => {
    const keycard = makeKeycardSpec()
    const meta = makeMetaByType()
    const edges = toFlowEdges(keycard, meta)
    expect(edges).toHaveLength(1)
    expect(edges[0].style).toEqual({ stroke: '#3b82f6' })
    expect(edges[0].markerEnd).toMatchObject({
      type: 'arrowclosed',
      color: '#3b82f6',
      width: 12,
      height: 12,
    })
  })
})

describe('fromFlow', () => {
  it('preserves positions from React Flow nodes', () => {
    const keycard = makeKeycardSpec()
    const rfNodes = keycard.nodes.map((n) => ({
      id: n.id,
      type: KEYCARD_NODE_TYPE,
      position: { x: n.position.x + 10, y: n.position.y + 20 },
      data: {},
    }))
    const next = fromFlow(keycard, rfNodes, toFlowEdges(keycard))
    next.nodes.forEach((n, i) => {
      expect(n.position).toEqual({
        x: keycard.nodes[i].position.x + 10,
        y: keycard.nodes[i].position.y + 20,
      })
    })
  })

  it('drops nodes and edges removed from the canvas', () => {
    const keycard = makeKeycardSpec()
    const rfNodes = keycard.nodes.slice(1).map((n) => ({
      id: n.id,
      type: KEYCARD_NODE_TYPE,
      position: n.position,
      data: {},
    }))
    const rfEdges = toFlowEdges(keycard).slice(1)
    const next = fromFlow(keycard, rfNodes, rfEdges)
    expect(next.nodes).toHaveLength(keycard.nodes.length - 1)
    expect(next.edges).toHaveLength(keycard.edges.length - 1)
    expect(next.nodes.find((n) => n.id === keycard.nodes[0].id)).toBeUndefined()
  })

  it('copies scalar metadata unchanged', () => {
    const keycard = makeKeycardSpec()
    const next = fromFlow(keycard, toFlowNodes(keycard, makeMetaByType()), toFlowEdges(keycard))
    expect(next.name).toBe(keycard.name)
    expect(next.windows).toEqual(keycard.windows)
    expect(next.tags).toEqual(keycard.tags)
  })
})

describe('layoutTree', () => {
  it('places roots at depth 0 and children one level to the right', () => {
    const keycard: KeycardSpec = {
      ...makeKeycardSpec(),
      nodes: [
        { id: 'a', type: 'run_per_candle', position: { x: 0, y: 0 }, config: {}, notes: '' },
        { id: 'b', type: 'previous_day_bullish', position: { x: 0, y: 0 }, config: {}, notes: '' },
        { id: 'c', type: 'buy_now', position: { x: 0, y: 0 }, config: {}, notes: '' },
      ],
      edges: [
        { id: 'e1', source: 'a', source_port: 'trigger', target: 'b', target_port: 'trigger' },
        { id: 'e2', source: 'a', source_port: 'trigger', target: 'c', target_port: 'trigger' },
      ],
    }
    const positions = layoutTree(keycard)
    expect(positions.get('a')!.x).toBe(0)
    expect(positions.get('b')!.x).toBe(220)
    expect(positions.get('c')!.x).toBe(220)
    expect(positions.get('b')!.y).not.toBe(positions.get('c')!.y)
  })
})

describe('routeDefects', () => {
  it('groups node defects by node id', () => {
    const defects = [
      { code: 'x', message: 'bad store', path: 'nodes[store-1].config.store', severity: 'blocking' as const },
      { code: 'y', message: 'bad universe', path: 'nodes[universe-1].config.universe', severity: 'blocking' as const },
    ]
    const routed = routeDefects(defects)
    expect(routed.get('store-1')).toHaveLength(1)
    expect(routed.get('universe-1')).toHaveLength(1)
    expect(routed.get('store-1')?.[0].message).toBe('bad store')
  })

  it('groups edge defects by edge id', () => {
    const defects = [
      { code: 'z', message: 'bad edge', path: 'edges[e1]', severity: 'advisory' as const },
    ]
    const routed = routeDefects(defects)
    expect(routed.get('e1')).toHaveLength(1)
  })

  it('ignores defects with unrecognised paths', () => {
    const defects = [
      { code: 'w', message: 'global', path: 'windows.train_start', severity: 'blocking' as const },
    ]
    const routed = routeDefects(defects)
    expect(routed.size).toBe(0)
  })
})
