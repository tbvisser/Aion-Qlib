/**
 * Translation between a Keycard spec and React Flow nodes/edges.
 *
 * This is the only module in the keycard frontend that imports `@xyflow/react`;
 * the components read these helpers rather than building graph shapes themselves.
 */
import { MarkerType, type Edge, type Node } from '@xyflow/react'

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

/** Width of a normal keycard node card. */
export const KEYCARD_NODE_WIDTH = 160
/** Height of a normal keycard node card. */
export const KEYCARD_NODE_HEIGHT = 56
/** Horizontal gap used when placing a newly added downstream node. */
export const KEYCARD_ADD_NEXT_GAP = 180
/** Vertical spacing between stacked downstream nodes from the same output port. */
export const KEYCARD_ADD_NEXT_VERTICAL_SPACING = 72

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
  /** Type of the port currently being dragged from, for highlighting compatible drop targets. */
  connectingPortType: KeycardPortType | null
  /** Which handle direction is a valid drop target while a connection is in flight. */
  seekingHandle: 'source' | 'target' | null
  onDoubleClick?: (nodeId: string) => void
  onCreateNode?: (sourceNodeId: string, sourcePortId: string, type: string) => void
  onReplaceStartNode?: (type: string) => void
  onReplaceAddNext?: (sourceNodeId: string, sourcePortId: string, type: string) => void
}

export interface KeycardEdgeData extends Record<string, unknown> {
  keycardEdge: KeycardEdgeSpec
  defects: KeycardDefect[]
}

export type KeycardFlowNode = Node<KeycardNodeData, typeof KEYCARD_NODE_TYPE>

export type KeycardFlowEdge = Edge<KeycardEdgeData>

function portHandleTop(meta: KeycardNodeTypeMeta | undefined, portId: string, direction: 'in' | 'out'): number {
  const ports = meta?.ports.filter((p) => p.direction === direction) ?? []
  if (ports.length <= 1) return KEYCARD_NODE_HEIGHT / 2
  const i = ports.findIndex((p) => p.id === portId)
  const idx = i < 0 ? 0 : i
  const count = ports.length
  // Distribute handles vertically with padding from top/bottom edges.
  const padding = 12
  const available = KEYCARD_NODE_HEIGHT - padding * 2
  return padding + (idx * available) / Math.max(count - 1, 1)
}

export function outputPortHandleTop(meta: KeycardNodeTypeMeta | undefined, portId: string): number {
  return portHandleTop(meta, portId, 'out')
}

export function inputPortHandleTop(meta: KeycardNodeTypeMeta | undefined, portId: string): number {
  return portHandleTop(meta, portId, 'in')
}

/**
 * Suggest a position for a newly added downstream node that comes after
 * `outgoingCount` existing edges from the same source port.
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
    y: sourceNode.position.y + top - KEYCARD_NODE_HEIGHT / 2 + outgoingCount * KEYCARD_ADD_NEXT_VERTICAL_SPACING,
  }
}

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
  onReplaceAddNext?: (sourceNodeId: string, sourcePortId: string, type: string) => void,
  connectingPortType: KeycardPortType | null = null,
  seekingHandle: 'source' | 'target' | null = null,
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
        metaByType,
        defects: routed.get(node.id) ?? [],
        selected: node.id === selectedId && node.type !== 'start',
        connectingPortType,
        seekingHandle,
        onDoubleClick,
        onCreateNode,
        onReplaceStartNode,
        onReplaceAddNext,
      },
      selected: node.id === selectedId && node.type !== 'start',
    }
  })
}

/**
 * Turn every keycard edge into a React Flow edge with typed handles and a
 * coloured arrow marker matching the source port type.
 */
export function toFlowEdges(
  keycard: Keycard | KeycardSpec,
  metaByType?: Map<string, KeycardNodeTypeMeta>,
): KeycardFlowEdge[] {
  const routed = routeDefects([])
  const edges: KeycardFlowEdge[] = keycard.edges.map((edge) => {
    const sourceNode = keycard.nodes.find((n) => n.id === edge.source)
    const sourceMeta = metaByType?.get(sourceNode?.type ?? '')
    const sourcePort = sourceMeta?.ports.find((p) => p.id === edge.source_port)
    const portColor = sourcePort ? (PORT_COLORS[sourcePort.type] ?? undefined) : undefined
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.source_port,
      targetHandle: edge.target_port,
      type: KEYCARD_EDGE_TYPE,
      style: portColor ? { stroke: portColor } : undefined,
      markerEnd: portColor
        ? { type: MarkerType.ArrowClosed, width: 12, height: 12, color: portColor }
        : undefined,
      data: { keycardEdge: edge, defects: routed.get(edge.id) ?? [] },
    }
  })

  return edges
}

/**
 * Rebuild a KeycardSpec from the current React Flow state.
 *
 * Positions come from `rfNodes`; config and topology come from the original
 * keycard. Nodes/edges removed from the canvas are dropped from the spec.
 *
 * Only real keycard nodes/edges are considered.
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
    x: rightmost.position.x + KEYCARD_NODE_WIDTH + 80,
    y: rightmost.position.y,
  }
}

/** Horizontal pitch between depth levels in the auto tree layout. */
const TREE_X_PITCH = 220
/** Vertical pitch between sibling nodes in the auto tree layout. */
const TREE_Y_PITCH = 90

/**
 * Compute a left-to-right tree layout for the keycard graph.
 *
 * Root nodes sit at depth 0; every downstream node is one depth level to the
 * right. Siblings are stacked vertically and centered under their parent when
 * possible. Isolated nodes are placed in a trailing column.
 */
export function layoutTree(
  keycard: Keycard | KeycardSpec,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (keycard.nodes.length === 0) return positions

  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  const nodeIds = new Set(keycard.nodes.map((n) => n.id))

  for (const node of keycard.nodes) {
    incoming.set(node.id, [])
    outgoing.set(node.id, [])
  }
  for (const edge of keycard.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    outgoing.get(edge.source)!.push(edge.target)
    incoming.get(edge.target)!.push(edge.source)
  }

  // Depth = longest path from any root.
  const depth = new Map<string, number>()
  function computeDepth(nodeId: string): number {
    if (depth.has(nodeId)) return depth.get(nodeId)!
    const parents = incoming.get(nodeId) ?? []
    const d = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(computeDepth))
    depth.set(nodeId, d)
    return d
  }
  for (const node of keycard.nodes) computeDepth(node.id)

  // Group nodes by depth.
  const byDepth = new Map<number, string[]>()
  for (const node of keycard.nodes) {
    const d = depth.get(node.id) ?? 0
    const list = byDepth.get(d) ?? []
    list.push(node.id)
    byDepth.set(d, list)
  }

  // Order nodes within each depth by a DFS pre-order so siblings stay together.
  const order = new Map<string, number>()
  let counter = 0
  const visited = new Set<string>()

  function dfs(nodeId: string) {
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    order.set(nodeId, counter++)
    for (const child of outgoing.get(nodeId) ?? []) {
      dfs(child)
    }
  }

  // Start DFS from roots in node order.
  const roots = keycard.nodes
    .filter((n) => (incoming.get(n.id) ?? []).length === 0)
    .map((n) => n.id)
  for (const root of roots) dfs(root)
  // Pick up any isolated/cycle nodes not reached from roots.
  for (const node of keycard.nodes) dfs(node.id)

  for (const [, list] of byDepth) {
    list.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  }

  // Assign y positions: center each depth column vertically around 0.
  for (const [d, list] of byDepth) {
    const columnHeight = (list.length - 1) * TREE_Y_PITCH
    list.forEach((id, i) => {
      positions.set(id, {
        x: d * TREE_X_PITCH,
        y: i * TREE_Y_PITCH - columnHeight / 2,
      })
    })
  }

  return positions
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
