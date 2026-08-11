/**
 * Deterministic placement for an expression tree.
 *
 * A general graph layout library would be the wrong dependency here: this is
 * always a tree, drawn right-rooted, so depth fixes x outright and a single
 * recursive walk fixes y. Edge crossings are impossible by construction.
 *
 * Determinism is the point. The same expression lays out identically every time,
 * which is what lets a catalog entry, a reloaded strategy and a screenshot all
 * agree, and what makes an end-to-end assertion about node positions meaningful.
 */
import { CATEGORY_LABELS } from './registry'
import type { ExprNode, OperatorRegistry, XY } from './types'

export const NODE_W = 210
const H_GAP = 56
const V_GAP = 20

const HEADER_H = 32
const ROW_H = 30
const FOOTER_H = 22
/** A field or a number is a header and nothing else -- its name is its value. */
const LEAF_H = 34

/** Card height, computed from the arg list so no measurement pass is needed. */
export function nodeHeight(node: ExprNode, registry: OperatorRegistry): number {
  if (node.kind !== 'call') return LEAF_H
  const spec = registry[node.op]
  const rows = spec ? spec.slots.length : 1
  return HEADER_H + rows * ROW_H + FOOTER_H
}

/** The children occupying series slots, in the operator's own slot order. */
export function seriesChildren(node: ExprNode, registry: OperatorRegistry): ExprNode[] {
  if (node.kind !== 'call') return []
  const spec = registry[node.op]
  const names = spec
    ? spec.slots.filter((s) => s.kind === 'series').map((s) => s.name)
    : Object.keys(node.args)
  return names.map((n) => node.args[n]).filter((c): c is ExprNode => Boolean(c))
}

/**
 * Positions for every node in the tree, with the root on the right.
 *
 * y comes from packing leaves in order and centring each parent between its
 * first and last child. The one departure from pure centring is a per-depth
 * collision guard: a parent taller than its children's span is pushed down
 * rather than allowed to overlap the node above it. Never overlapping is worth
 * more than being perfectly centred.
 */
export function layoutTree(root: ExprNode, registry: OperatorRegistry): Record<string, XY> {
  const depth: Record<string, number> = {}
  const top: Record<string, number> = {}
  const height: Record<string, number> = {}
  /** Lowest edge used so far at each depth, so siblings cannot collide. */
  const floor: Record<number, number> = {}
  let leafCursor = 0

  const place = (node: ExprNode, d: number): number => {
    depth[node.id] = d
    const h = nodeHeight(node, registry)
    height[node.id] = h

    const children = seriesChildren(node, registry)
    let centre: number
    if (children.length === 0) {
      centre = leafCursor + h / 2
    } else {
      const centres = children.map((c) => place(c, d + 1))
      centre = (centres[0] + centres[centres.length - 1]) / 2
    }

    let y = centre - h / 2
    const limit = floor[d]
    if (limit !== undefined && y < limit) y = limit
    top[node.id] = y
    floor[d] = y + h + V_GAP
    if (children.length === 0) leafCursor = Math.max(leafCursor, y + h + V_GAP)
    return y + h / 2
  }

  place(root, 0)

  const maxDepth = Math.max(...Object.values(depth))
  const minTop = Math.min(...Object.values(top))
  const out: Record<string, XY> = {}
  for (const id of Object.keys(depth)) {
    out[id] = {
      // Every node sits exactly one pitch left of its parent, whatever the
      // depth of the deepest branch.
      x: Math.round((maxDepth - depth[id]) * (NODE_W + H_GAP)),
      y: Math.round(top[id] - minTop),
    }
  }
  return out
}

/**
 * Stored positions, with a computed one for every node that has none.
 *
 * Hand-placed nodes win: a canvas that scrambles itself when reopened reads as
 * broken. Auto-layout is the fallback for a tree that arrived as a string --
 * from the catalog, a saved strategy, or the chat agent -- and for whatever the
 * Tidy button re-derives.
 */
export function resolvePositions(
  root: ExprNode, registry: OperatorRegistry, stored: Record<string, XY>,
): Record<string, XY> {
  const auto = layoutTree(root, registry)
  const out: Record<string, XY> = {}
  for (const id of Object.keys(auto)) out[id] = stored[id] ?? auto[id]
  return out
}

/** Group label for a card's chip, e.g. `ROLLING WINDOWS`. */
export function categoryLabel(node: ExprNode, registry: OperatorRegistry): string {
  if (node.kind === 'field') return 'Field'
  if (node.kind === 'const') return 'Number'
  const spec = registry[node.op]
  return spec ? CATEGORY_LABELS[spec.category] : 'Unknown'
}
