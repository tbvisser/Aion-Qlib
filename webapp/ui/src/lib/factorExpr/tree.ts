/**
 * Every structural change to an expression, as a pure function.
 *
 * Each edit returns a new tree, sharing every untouched subtree and rebuilding
 * only the path from the root to the change. Node ids survive, which is what
 * lets hand-placed positions survive an edit somewhere else in the tree.
 *
 * Because these are the only way the tree changes, undo is a stack of trees and
 * nothing has to be diffed or reversed.
 */
import type {
  CallNode, ExprNode, OperatorRegistry, OperatorSpec,
} from './types'
import { call } from './types'

/** The series slot names of a call node, in the operator's own order. */
export function seriesSlots(node: CallNode, registry: OperatorRegistry): string[] {
  const spec = registry[node.op]
  return spec
    ? spec.slots.filter((s) => s.kind === 'series').map((s) => s.name)
    : Object.keys(node.args)
}

export function findNode(root: ExprNode, id: string): ExprNode | null {
  if (root.id === id) return root
  if (root.kind !== 'call') return null
  for (const child of Object.values(root.args)) {
    if (!child) continue
    const hit = findNode(child, id)
    if (hit) return hit
  }
  return null
}

export function findParent(
  root: ExprNode, id: string,
): { parent: CallNode; slot: string } | null {
  if (root.kind !== 'call') return null
  for (const [slot, child] of Object.entries(root.args)) {
    if (!child) continue
    if (child.id === id) return { parent: root, slot }
    const hit = findParent(child, id)
    if (hit) return hit
  }
  return null
}

/** Rebuild the tree with `fn` applied to the node with this id. */
export function updateNode(
  root: ExprNode, id: string, fn: (node: ExprNode) => ExprNode,
): ExprNode {
  if (root.id === id) return fn(root)
  if (root.kind !== 'call') return root

  let changed = false
  const args: Record<string, ExprNode | null> = {}
  for (const [slot, child] of Object.entries(root.args)) {
    const next = child ? updateNode(child, id, fn) : null
    if (next !== child) changed = true
    args[slot] = next
  }
  return changed ? { ...root, args } : root
}

/** Change a numeric literal in place. */
export function setConst(root: ExprNode, id: string, value: number): ExprNode {
  return updateNode(root, id, (node) =>
    (node.kind === 'const' ? { ...node, value } : node))
}

/** Point a leaf at a different column of the store. */
export function setField(root: ExprNode, id: string, name: string): ExprNode {
  return updateNode(root, id, (node) =>
    (node.kind === 'field' ? { ...node, name } : node))
}

/** Set a window or scalar. `null` clears it back to unfilled. */
export function setParam(
  root: ExprNode, id: string, slot: string, value: number | null,
): ExprNode {
  return updateNode(root, id, (node) =>
    node.kind === 'call' ? { ...node, params: { ...node.params, [slot]: value } } : node)
}

/** Put `child` (or nothing) into a series slot. */
export function setSlot(
  root: ExprNode, parentId: string, slot: string, child: ExprNode | null,
): ExprNode {
  return updateNode(root, parentId, (node) =>
    node.kind === 'call' ? { ...node, args: { ...node.args, [slot]: child } } : node)
}

/**
 * Take a node out of the tree.
 *
 * Removing the root would leave nothing to draw, so it is refused: an expression
 * always has a root, and "start again" is a different action than "delete this".
 */
export function removeNode(root: ExprNode, id: string): ExprNode {
  const found = findParent(root, id)
  return found ? setSlot(root, found.parent.id, found.slot, null) : root
}

/**
 * Swap a node's operator, keeping as many children as the new one has room for.
 *
 * Slots are matched by position rather than by name, because `Mean(x, N)` and
 * `Corr(x, y, N)` do not share a vocabulary but do share a first argument.
 * Children beyond the new operator's arity are dropped -- stated here because it
 * is the one lossy edit in this module.
 */
export function replaceOp(
  root: ExprNode, id: string, spec: OperatorSpec, registry: OperatorRegistry,
): ExprNode {
  return updateNode(root, id, (node) => {
    if (node.kind !== 'call') return node
    const oldSeries = seriesSlots(node, registry).map((s) => node.args[s] ?? null)
    const oldParams = Object.values(node.params)

    const next = call(spec)
    next.id = node.id  // keep the id so the card does not jump

    const newSeries = spec.slots.filter((s) => s.kind === 'series')
    newSeries.forEach((slot, i) => { next.args[slot.name] = oldSeries[i] ?? null })
    const newParams = spec.slots.filter((s) => s.kind !== 'series')
    newParams.forEach((slot, i) => { next.params[slot.name] = oldParams[i] ?? null })
    return next
  })
}

/** The first unfilled series slot in depth-first order, if any. */
export function firstEmptySlot(
  root: ExprNode, registry: OperatorRegistry,
): { nodeId: string; slot: string } | null {
  if (root.kind !== 'call') return null
  for (const slot of seriesSlots(root, registry)) {
    if (!root.args[slot]) return { nodeId: root.id, slot }
  }
  for (const slot of seriesSlots(root, registry)) {
    const child = root.args[slot]
    if (!child) continue
    const hit = firstEmptySlot(child, registry)
    if (hit) return hit
  }
  return null
}

/** An empty series slot on this node specifically. */
function emptySlotOn(
  root: ExprNode, id: string, registry: OperatorRegistry,
): { nodeId: string; slot: string } | null {
  const node = findNode(root, id)
  if (!node || node.kind !== 'call') return null
  for (const slot of seriesSlots(node, registry)) {
    if (!node.args[slot]) return { nodeId: node.id, slot }
  }
  return null
}

/** Put `node` where `targetId` currently sits, whether that is a slot or the root. */
function replaceInPlace(root: ExprNode, targetId: string, node: ExprNode): ExprNode {
  if (root.id === targetId) return node
  const found = findParent(root, targetId)
  return found ? setSlot(root, found.parent.id, found.slot, node) : root
}

/**
 * Add something from the palette, doing the obvious thing.
 *
 * Two rules, and they are the whole contract:
 *
 *   an operator **wraps** the selection -- select `$close`, click Mean, get
 *   `Mean($close,?)`, which is how expressions are actually built, outwards
 *   from a series;
 *   a leaf **replaces** the selection -- clicking `$volume` on a selected
 *   `$close` can only mean swap this for that.
 *
 * Filling an empty slot on the selected card comes first, because a visible
 * hole is a stronger request than either. With nothing selected, the first hole
 * anywhere gets it, and failing that the new block wraps the root.
 *
 * Every branch changes something. An earlier version left a leaf clicked onto a
 * fully-filled card doing nothing at all, which is indistinguishable from a
 * broken button; replacing is destructive but visible, and one undo away.
 */
export function insertBlock(
  root: ExprNode, selectedId: string | null, incoming: ExprNode,
  registry: OperatorRegistry,
): ExprNode {
  const target = selectedId ? emptySlotOn(root, selectedId, registry) : null
  if (target) return setSlot(root, target.nodeId, target.slot, incoming)

  const selected = selectedId ? findNode(root, selectedId) : null
  if (selected) {
    if (incoming.kind !== 'call') return replaceInPlace(root, selected.id, incoming)
    const slots = seriesSlots(incoming, registry)
    if (slots.length > 0) {
      const wrapped = { ...incoming, args: { ...incoming.args, [slots[0]]: selected } }
      return replaceInPlace(root, selected.id, wrapped)
    }
  }

  const anywhere = firstEmptySlot(root, registry)
  if (anywhere) return setSlot(root, anywhere.nodeId, anywhere.slot, incoming)

  if (incoming.kind === 'call') {
    const slots = seriesSlots(incoming, registry)
    if (slots.length > 0) {
      return { ...incoming, args: { ...incoming.args, [slots[0]]: root } }
    }
  }
  return root
}
