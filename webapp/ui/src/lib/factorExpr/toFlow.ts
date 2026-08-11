/**
 * Expression tree -> React Flow nodes and edges.
 *
 * The tree is the source of truth and this is a projection of it. Nothing here
 * is ever edited in place: the canvas writes back only node positions, and every
 * structural change goes through a pure edit on the tree and comes back out
 * here. That is what makes it impossible to reach a state that cannot be
 * serialised -- the usual failure of letting the graph library hold the truth.
 *
 * The only module in the app that imports React Flow types.
 */
import type { Edge, Node } from '@xyflow/react'

import { categoryLabel, nodeHeight, seriesChildren, NODE_W } from './layout'
import { serializeNode } from './serialize'
import type { ExprNode, OperatorRegistry, OperatorSpec, XY } from './types'

/**
 * A type alias rather than an interface on purpose: React Flow constrains node
 * data to `Record<string, unknown>`, and only a type alias picks up the implicit
 * index signature that satisfies it.
 */
export type ExprCardData = {
  node: ExprNode
  spec: OperatorSpec | undefined
  /** Group chip, resolved here so the card never needs the whole registry. */
  category: string
  /** This node's own sub-expression, printed in its footer. */
  text: string
  /** The output of the whole expression, drawn in mint. */
  isRoot: boolean
  /** Some slot below here is still empty. */
  incomplete: boolean
  width: number
  height: number
}

export type ExprFlowNode = Node<ExprCardData, 'expr'>

export const EXPR_NODE_TYPE = 'expr'

/** `[child, parent, slot]` for every filled series slot in the tree. */
function links(root: ExprNode, registry: OperatorRegistry): [ExprNode, ExprNode, string][] {
  const out: [ExprNode, ExprNode, string][] = []
  const visit = (node: ExprNode) => {
    if (node.kind !== 'call') return
    const spec = registry[node.op]
    const names = spec
      ? spec.slots.filter((s) => s.kind === 'series').map((s) => s.name)
      : Object.keys(node.args)
    for (const name of names) {
      const child = node.args[name]
      if (!child) continue
      out.push([child, node, name])
      visit(child)
    }
  }
  visit(root)
  return out
}

function every(root: ExprNode, registry: OperatorRegistry): ExprNode[] {
  const out: ExprNode[] = []
  const visit = (n: ExprNode) => {
    out.push(n)
    for (const child of seriesChildren(n, registry)) visit(child)
  }
  visit(root)
  return out
}

/** True when this node or anything under it still has an unfilled slot. */
function incompleteAt(node: ExprNode, registry: OperatorRegistry): boolean {
  if (node.kind !== 'call') return false
  const spec = registry[node.op]
  if (!spec) return true
  for (const slot of spec.slots) {
    if (slot.kind === 'series') {
      const child = node.args[slot.name]
      if (!child) return true
      if (incompleteAt(child, registry)) return true
    } else if (node.params[slot.name] === null || node.params[slot.name] === undefined) {
      return true
    }
  }
  return false
}

export function toFlowNodes(
  root: ExprNode, registry: OperatorRegistry, positions: Record<string, XY>,
): ExprFlowNode[] {
  return every(root, registry).map((node) => ({
    id: node.id,
    type: EXPR_NODE_TYPE,
    position: positions[node.id] ?? { x: 0, y: 0 },
    data: {
      node,
      spec: node.kind === 'call' ? registry[node.op] : undefined,
      category: categoryLabel(node, registry),
      text: serializeNode(node, registry),
      isRoot: node.id === root.id,
      incomplete: incompleteAt(node, registry),
      width: NODE_W,
      height: nodeHeight(node, registry),
    },
  }))
}

export function toFlowEdges(root: ExprNode, registry: OperatorRegistry): Edge[] {
  return links(root, registry).map(([child, parent, slot]) => ({
    id: `${child.id}->${parent.id}.${slot}`,
    source: child.id,
    sourceHandle: 'out',
    target: parent.id,
    targetHandle: slot,
    type: 'default',
  }))
}
