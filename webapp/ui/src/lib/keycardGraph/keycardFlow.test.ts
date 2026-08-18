import { describe, expect, it } from 'vitest'

import { defaultKeycardSpec } from '@/lib/api'
import {
  KEYCARD_EDGE_TYPE,
  KEYCARD_NODE_TYPE,
  fromFlow,
  routeDefects,
  toFlowEdges,
  toFlowNodes,
} from './keycardFlow'

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
    const keycard = defaultKeycardSpec()
    const nodes = toFlowNodes(keycard, makeMetaByType())
    expect(nodes).toHaveLength(keycard.nodes.length)
    nodes.forEach((n, i) => {
      expect(n.id).toBe(keycard.nodes[i].id)
      expect(n.type).toBe(KEYCARD_NODE_TYPE)
      expect(n.position).toEqual(keycard.nodes[i].position)
      expect(n.data.keycardNode).toEqual(keycard.nodes[i])
    })
  })

  it('marks the selected node', () => {
    const keycard = defaultKeycardSpec()
    const nodes = toFlowNodes(keycard, makeMetaByType(), [], keycard.nodes[0].id)
    expect(nodes[0].selected).toBe(true)
    expect(nodes[1].selected).toBe(false)
  })

  it('attaches metadata by node type', () => {
    const keycard = {
      ...defaultKeycardSpec(),
      nodes: [
        { id: 'store-1', type: 'data_store', position: { x: 0, y: 0 }, config: { store: 'us' }, notes: '' },
        { id: 'universe-1', type: 'universe', position: { x: 0, y: 100 }, config: {}, notes: '' },
      ],
      edges: [],
    }
    const nodes = toFlowNodes(keycard, makeMetaByType())
    expect(nodes[0].data.meta?.label).toBe('Data Store')
    expect(nodes[1].data.meta?.label).toBe('Universe')
  })
})

describe('toFlowEdges', () => {
  it('produces one React Flow edge per keycard edge with typed handles', () => {
    const keycard = defaultKeycardSpec()
    const edges = toFlowEdges(keycard)
    expect(edges).toHaveLength(keycard.edges.length)
    edges.forEach((e, i) => {
      expect(e.id).toBe(keycard.edges[i].id)
      expect(e.type).toBe(KEYCARD_EDGE_TYPE)
      expect(e.sourceHandle).toBe(keycard.edges[i].source_port)
      expect(e.targetHandle).toBe(keycard.edges[i].target_port)
    })
  })
})

describe('fromFlow', () => {
  it('preserves positions from React Flow nodes', () => {
    const keycard = defaultKeycardSpec()
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
    const keycard = defaultKeycardSpec()
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
    const keycard = defaultKeycardSpec()
    const next = fromFlow(keycard, toFlowNodes(keycard, makeMetaByType()), toFlowEdges(keycard))
    expect(next.name).toBe(keycard.name)
    expect(next.windows).toEqual(keycard.windows)
    expect(next.tags).toEqual(keycard.tags)
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
