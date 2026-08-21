/**
 * Translation between a Keycard spec and React Flow nodes/edges.
 *
 * This is the only module in the keycard frontend that imports `@xyflow/react`;
 * the components read these helpers rather than building graph shapes themselves.
 */
import type { Edge, Node } from '@xyflow/react'

import type {
  Keycard,
  KeycardDefect,
  KeycardEdge as KeycardEdgeSpec,
  KeycardNode as KeycardNodeSpec,
  KeycardNodeTypeMeta,
  KeycardPortType,
  KeycardSpec,
} from '@/lib/api'

export const KEYCARD_NODE_TYPE = 'keycardNode'
export const KEYCARD_EDGE_TYPE = 'keycardEdge'
export const KEYCARD_ADD_NEXT_TYPE = '__addNext'

/** Width of a normal keycard node card. */
export const KEYCARD_NODE_WIDTH = 236
/** Horizontal gap between a node and its add-next pseudo-node. */
export const KEYCARD_ADD_NEXT_GAP = 120
/** Vertical spacing between stacked downstream nodes from the same output port. */
export const KEYCARD_ADD_NEXT_VERTICAL_SPACING = 100

export const PORT_COLORS: Record<KeycardPortType, string> = {
  data: '#3b82f6', // blue-500
  features: '#a855f7', // purple-500
  signal: '#22c55e', // green-500
  trades: '#f97316', // orange-500
  config: '#6b7280', // gray-500
  trigger: '#34d399', // emerald-400
  trade: '#f97316', // orange-500
  value: '#fbbf24', // amber-400
}

export interface KeycardNodeData extends Record<string, unknown> {
  keycardNode: KeycardNodeSpec
  meta: KeycardNodeTypeMeta | undefined
  metaByType: Map<string, KeycardNodeTypeMeta>
  defects: KeycardDefect[]
  selected: boolean
  onDoubleClick?: (nodeId: string) => void
  onCreateNode?: (sourceNodeId: string, sourcePortId: string, type: string) => void
  onReplaceStartNode?: (type: string) => void
  onReplaceAddNext?: (sourceNodeId: string, sourcePortId: string, type: string) => void
}

export interface KeycardAddNextData extends Record<string, unknown> {
  sourceNodeId: string
  sourcePortId: string
  metaByType: Map<string, KeycardNodeTypeMeta>
  onReplaceAddNext?: (sourceNodeId: string, sourcePortId: string, type: string) => void
}

export interface KeycardEdgeData extends Record<string, unknown> {
  keycardEdge: KeycardEdgeSpec
  defects: KeycardDefect[]
}

export type KeycardFlowNode =
  | Node<KeycardNodeData, typeof KEYCARD_NODE_TYPE>
  | Node<KeycardAddNextData, typeof KEYCARD_ADD_NEXT_TYPE>

export type KeycardFlowEdge = Edge<KeycardEdgeData>

function outputPortHandleTop(meta: KeycardNodeTypeMeta | undefined, portId: string): number {
  const outputPorts = meta?.ports.filter((p) => p.direction === 'out') ?? []
  if (outputPorts.length === 0) return 46
  const i = outputPorts.findIndex((p) => p.id === portId)
  const idx = i < 0 ? 0 : i
  const count = outputPorts.length
  return count === 1 ? 46 : 18 + (idx * 56) / Math.max(count - 1, 1)
}

/**
 * Suggest a position for the add-next pseudo-node (or a newly added node) that
 * comes after `outgoingCount` existing edges from the same source port.
 *
 * Nodes branch vertically: the first downstream node sits level with the output
 * handle, the next one below it, and so on.
 */
export function addNextPosition(
  sourceNode: KeycardNodeSpec,
  sourcePortId: string,
  metaByType: Map<string, KeycardNodeTypeMeta>,
  outgoingCount: number,
): { x: number; y: number } {
  const meta = metaByType.get(sourceNode.type)
  const top = outputPortHandleTop(meta, sourcePortId)
  return {
    x: sourceNode.position.x + KEYCARD_NODE_WIDTH + KEYCARD_ADD_NEXT_GAP,
    y: sourceNode.position.y + top - 22 + outgoingCount * KEYCARD_ADD_NEXT_VERTICAL_SPACING,
  }
}

function addNextNodeId(sourceNodeId: string, sourcePortId: string): string {
  return `__addNext-${sourceNodeId}-${sourcePortId}`
}

function addNextEdgeId(sourceNodeId: string, sourcePortId: string): string {
  return `__edge-addNext-${sourceNodeId}-${sourcePortId}`
}

export function isAddNextNodeId(id: string): boolean {
  return id.startsWith('__addNext-')
}

export function parseAddNextNodeId(
  id: string,
): { sourceNodeId: string; sourcePortId: string } | null {
  if (!id.startsWith('__addNext-')) return null
  const rest = id.slice('__addNext-'.length)
  const firstDash = rest.indexOf('-')
  if (firstDash < 0) return null
  return {
    sourceNodeId: rest.slice(0, firstDash),
    sourcePortId: rest.slice(firstDash + 1),
  }
}

export function parseAddNextEdgeId(
  id: string,
): { sourceNodeId: string; sourcePortId: string } | null {
  if (!id.startsWith('__edge-addNext-')) return null
  const rest = id.slice('__edge-addNext-'.length)
  const firstDash = rest.indexOf('-')
  if (firstDash < 0) return null
  return {
    sourceNodeId: rest.slice(0, firstDash),
    sourcePortId: rest.slice(firstDash + 1),
  }
}

/**
 * Turn every keycard node into a React Flow node.
 *
 * `metaByType` maps node type ids to palette metadata so the card can show the
 * right icon, label and port list. Missing metadata is handled gracefully.
 *
 * Also injects an ephemeral `__addNext` pseudo-node after every output port
 * that has no outgoing edges. These pseudo-nodes are rendered as "+" buttons
 * and are never persisted to the keycard spec.
 */
export function toFlowNodes(
  keycard: Keycard | KeycardSpec,
  metaByType: Map<string, KeycardNodeTypeMeta>,
  defects: KeycardDefect[] = [],
  selectedId?: string | null,
  onDoubleClick?: (nodeId: string) => void,
  onCreateNode?: (sourceNodeId: string, sourcePortId: string, type: string) => void,
  onReplaceStartNode?: (type: string) => void,
  onReplaceAddNext?: (sourceNodeId: string, sourcePortId: string, type: string) => void,
): KeycardFlowNode[] {
  const routed = routeDefects(defects)
  const nodes: KeycardFlowNode[] = keycard.nodes.map((node) => {
    const meta = metaByType.get(node.type)
    return {
      id: node.id,
      type: KEYCARD_NODE_TYPE,
      position: { ...node.position },
      data: {
        keycardNode: node,
        meta,
        metaByType,
        defects: routed.get(node.id) ?? [],
        selected: node.id === selectedId && node.type !== 'start',
        onDoubleClick,
        onCreateNode,
        onReplaceStartNode,
        onReplaceAddNext,
      },
      selected: node.id === selectedId && node.type !== 'start',
    }
  })

  for (const node of keycard.nodes) {
    const meta = metaByType.get(node.type)
    if (!meta) continue
    for (const port of meta.ports) {
      if (port.direction !== 'out') continue
      const outgoingCount = keycard.edges.filter(
        (e) => e.source === node.id && e.source_port === port.id,
      ).length
      nodes.push({
        id: addNextNodeId(node.id, port.id),
        type: KEYCARD_ADD_NEXT_TYPE,
        position: addNextPosition(node, port.id, metaByType, outgoingCount),
        data: {
          sourceNodeId: node.id,
          sourcePortId: port.id,
          metaByType,
          onReplaceAddNext,
        },
        selectable: false,
        draggable: false,
      })
    }
  }

  return nodes
}

/**
 * Turn every keycard edge into a React Flow edge with typed handles.
 *
 * Also emits a dashed virtual edge from every output port to its ephemeral
 * `__addNext` pseudo-node, even when the port already has outgoing edges, so
 * users can keep branching the workflow.
 */
export function toFlowEdges(
  keycard: Keycard | KeycardSpec,
  metaByType?: Map<string, KeycardNodeTypeMeta>,
): KeycardFlowEdge[] {
  const routed = routeDefects([])
  const edges: KeycardFlowEdge[] = keycard.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.source_port,
    targetHandle: edge.target_port,
    type: KEYCARD_EDGE_TYPE,
    data: { keycardEdge: edge, defects: routed.get(edge.id) ?? [] },
  }))

  for (const node of keycard.nodes) {
    const meta = metaByType?.get(node.type)
    if (!meta) continue
    for (const port of meta.ports) {
      if (port.direction !== 'out') continue
      edges.push({
        id: addNextEdgeId(node.id, port.id),
        source: node.id,
        target: addNextNodeId(node.id, port.id),
        sourceHandle: port.id,
        targetHandle: 'in',
        type: KEYCARD_EDGE_TYPE,
        data: { keycardEdge: { id: addNextEdgeId(node.id, port.id) } as KeycardEdgeSpec, defects: [] },
        style: { strokeDasharray: '4 4' },
      })
    }
  }

  return edges
}

/**
 * Rebuild a KeycardSpec from the current React Flow state.
 *
 * Positions come from `rfNodes`; config and topology come from the original
 * keycard. Nodes/edges removed from the canvas are dropped from the spec.
 *
 * Ephemeral `__addNext` pseudo-nodes and their virtual edges are ignored.
 */
export function fromFlow(
  keycard: Keycard | KeycardSpec,
  rfNodes: Node[],
  rfEdges: Edge[],
): KeycardSpec {
  const positions = new Map(rfNodes.map((n) => [n.id, n.position]))
  const nodeIds = new Set(rfNodes.map((n) => n.id).filter((id) => !isAddNextNodeId(id)))

  const nodes: KeycardNodeSpec[] = keycard.nodes
    .filter((n) => nodeIds.has(n.id))
    .map((n) => {
      const pos = positions.get(n.id)
      return {
        ...n,
        position: pos ? { ...pos } : { ...n.position },
      }
    })

  const edgeIds = new Set(
    rfEdges.map((e) => e.id).filter((id) => !id.startsWith('__edge-addNext-')),
  )
  const edges: KeycardEdgeSpec[] = keycard.edges
    .filter((e) => edgeIds.has(e.id))
    .map((e) => ({ ...e }))

  return {
    name: keycard.name,
    description: keycard.description,
    tags: [...keycard.tags],
    is_template: keycard.is_template,
    template_family: keycard.template_family,
    nodes,
    edges,
    windows: { ...keycard.windows },
  }
}

/**
 * Detect whether the directed graph formed by the keycard edges contains a
 * cycle. Uses DFS with a recursion stack. Isolated nodes do not affect the
 * result.
 */
export function hasCycle(keycard: Keycard | KeycardSpec): boolean {
  const adj = new Map<string, string[]>()
  for (const node of keycard.nodes) {
    adj.set(node.id, [])
  }
  for (const edge of keycard.edges) {
    const list = adj.get(edge.source) ?? []
    list.push(edge.target)
    adj.set(edge.source, list)
  }

  const visited = new Set<string>()
  const stack = new Set<string>()

  function dfs(nodeId: string): boolean {
    visited.add(nodeId)
    stack.add(nodeId)
    for (const neighbor of adj.get(nodeId) ?? []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true
      } else if (stack.has(neighbor)) {
        return true
      }
    }
    stack.delete(nodeId)
    return false
  }

  for (const node of keycard.nodes) {
    if (!visited.has(node.id)) {
      if (dfs(node.id)) return true
    }
  }
  return false
}

/**
 * Check whether adding a candidate edge would create a cycle.
 */
export function wouldCreateCycle(
  keycard: Keycard | KeycardSpec,
  candidate: KeycardEdgeSpec,
): boolean {
  return hasCycle({
    ...keycard,
    edges: [...keycard.edges, candidate],
  })
}

/**
 * Suggest a drop position for a new node.
 *
 * Places it to the right of the right-most existing node, or centred when the
 * canvas is empty.
 */
export function defaultNodePosition(
  keycard: Keycard | KeycardSpec,
  _type: string,
): { x: number; y: number } {
  if (keycard.nodes.length === 0) {
    return { x: 0, y: 0 }
  }
  const rightmost = keycard.nodes.reduce((acc, n) =>
    n.position.x > acc.position.x ? n : acc,
  )
  return {
    x: rightmost.position.x + 220,
    y: rightmost.position.y,
  }
}

const NODE_PATH_RE = /^nodes\[([^\]]+)\]/
const EDGE_PATH_RE = /^edges\[([^\]]+)\]/

/**
 * Parse defect paths like `nodes[store-1].config.store` or `edges[e1]` and
 * group them by the node or edge id they name.
 */
export function routeDefects(defects: KeycardDefect[]): Map<string, KeycardDefect[]> {
  const out = new Map<string, KeycardDefect[]>()
  for (const defect of defects) {
    let key: string | null = null
    const nodeMatch = NODE_PATH_RE.exec(defect.path)
    if (nodeMatch) {
      key = nodeMatch[1]
    } else {
      const edgeMatch = EDGE_PATH_RE.exec(defect.path)
      if (edgeMatch) key = edgeMatch[1]
    }
    if (key === null) continue
    const list = out.get(key) ?? []
    list.push(defect)
    out.set(key, list)
  }
  return out
}
