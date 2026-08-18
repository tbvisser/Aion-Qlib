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
  defects: KeycardDefect[]
  selected: boolean
  onDoubleClick?: (nodeId: string) => void
  onCreateNode?: (sourceNodeId: string, sourcePortId: string, type: string) => void
  onReplaceStartNode?: (type: string) => void
}

export interface KeycardEdgeData extends Record<string, unknown> {
  keycardEdge: KeycardEdgeSpec
  defects: KeycardDefect[]
}

export type KeycardFlowNode = Node<KeycardNodeData, typeof KEYCARD_NODE_TYPE>
export type KeycardFlowEdge = Edge<KeycardEdgeData>

/**
 * Turn every keycard node into a React Flow node.
 *
 * `metaByType` maps node type ids to palette metadata so the card can show the
 * right icon, label and port list. Missing metadata is handled gracefully.
 */
export function toFlowNodes(
  keycard: Keycard | KeycardSpec,
  metaByType: Map<string, KeycardNodeTypeMeta>,
  defects: KeycardDefect[] = [],
  selectedId?: string | null,
  onDoubleClick?: (nodeId: string) => void,
  onCreateNode?: (sourceNodeId: string, sourcePortId: string, type: string) => void,
  onReplaceStartNode?: (type: string) => void,
): KeycardFlowNode[] {
  const routed = routeDefects(defects)
  return keycard.nodes.map((node) => {
    const meta = metaByType.get(node.type)
    return {
      id: node.id,
      type: KEYCARD_NODE_TYPE,
      position: { ...node.position },
      data: {
        keycardNode: node,
        meta,
        defects: routed.get(node.id) ?? [],
        selected: node.id === selectedId && node.type !== 'start',
        onDoubleClick,
        onCreateNode,
        onReplaceStartNode,
      },
      selected: node.id === selectedId && node.type !== 'start',
    }
  })
}

/**
 * Turn every keycard edge into a React Flow edge with typed handles.
 */
export function toFlowEdges(keycard: Keycard | KeycardSpec): KeycardFlowEdge[] {
  const routed = routeDefects([])
  return keycard.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.source_port,
    targetHandle: edge.target_port,
    type: KEYCARD_EDGE_TYPE,
    data: { keycardEdge: edge, defects: routed.get(edge.id) ?? [] },
  }))
}

/**
 * Rebuild a KeycardSpec from the current React Flow state.
 *
 * Positions come from `rfNodes`; config and topology come from the original
 * keycard. Nodes/edges removed from the canvas are dropped from the spec.
 */
export function fromFlow(
  keycard: Keycard | KeycardSpec,
  rfNodes: Node[],
  rfEdges: Edge[],
): KeycardSpec {
  const positions = new Map(rfNodes.map((n) => [n.id, n.position]))
  const nodeIds = new Set(rfNodes.map((n) => n.id))

  const nodes: KeycardNodeSpec[] = keycard.nodes
    .filter((n) => nodeIds.has(n.id))
    .map((n) => {
      const pos = positions.get(n.id)
      return {
        ...n,
        position: pos ? { ...pos } : { ...n.position },
      }
    })

  const edgeIds = new Set(rfEdges.map((e) => e.id))
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
