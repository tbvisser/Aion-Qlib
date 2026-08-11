/**
 * The expression tree, and the shape of the operator vocabulary that describes it.
 *
 * A qlib factor expression is a tree: `Ref($close,20)/$close - 1` is a Sub whose
 * left is a Div whose left is a Ref. The canvas draws that tree, and this module
 * is the only place its shape is defined.
 *
 * Deliberately a tree and not a general graph: the qlib string language has no
 * `let`, so a shared sub-expression would serialise as two copies and reading it
 * back would produce a different graph than the one drawn. Round-trip fidelity is
 * worth more here than avoiding a duplicated subtree, which qlib recomputes
 * cheaply.
 */

/** How a node's argument is supplied. */
export type SlotKind =
  /** Another expression. Drawn as a port. */
  | 'series'
  /**
   * A rolling window, consumed by the operator's constructor. Drawn as an inline
   * number input and never a port: `Ref(x, 20)`'s 20 cannot be an expression, so
   * a port there would invite building something qlib's parser rejects.
   */
  | 'window'
  /** A plain number that is not a window, e.g. `Quantile`'s quantile. */
  | 'scalar'

export interface SlotSpec {
  name: string
  kind: SlotKind
  /** Shown as the port/field label. Defaults to `name`. */
  label?: string
}

export type OpCategory =
  | 'arithmetic' | 'compare' | 'rolling' | 'pair' | 'elementwise' | 'logic'

/**
 * Rolling-window semantics, from qlib/data/ops.py:747-752. The same integer box
 * means three different things, so the card shows which one is in force.
 */
export interface WindowSemantics {
  /** `N == 0` expands over all history rather than a fixed window. */
  expandingAtZero: boolean
  /** `0 < N < 1` is an EWM alpha, not a day count. */
  ewmBelowOne: boolean
  /** Smallest legal window; qlib raises below it (Skew needs 3, Kurt needs 5). */
  min?: number
  /** Only `Ref` accepts a negative offset, and only in a label. */
  allowsNegative?: boolean
}

export interface OperatorSpec {
  /** Registry key and qlib's own name: `Ref`, `Add`, `Corr`. */
  name: string
  /** Set when the canonical rendering is infix: `+`, `/`, `>`. */
  symbol?: string
  /** Binding power; higher binds tighter. Only meaningful with `symbol`. */
  precedence?: number
  /** `**` is the only right-associative operator in the language. */
  rightAssociative?: boolean
  category: OpCategory
  summary: string
  slots: SlotSpec[]
  window?: WindowSemantics
}

export type OperatorRegistry = Record<string, OperatorSpec>

/** A leaf reading a column out of the store: `$close`. */
export interface FieldNode {
  id: string
  kind: 'field'
  /** Without the `$`. */
  name: string
}

/** A numeric literal: the `20` in `$close - 20`, or `1e-12`. */
export interface ConstNode {
  id: string
  kind: 'const'
  value: number
}

/**
 * An operator applied to its slots. Series slots live in `args` and may be null
 * while the user is still building; window/scalar slots live in `params`.
 */
export interface CallNode {
  id: string
  kind: 'call'
  op: string
  args: Record<string, ExprNode | null>
  params: Record<string, number | null>
}

export type ExprNode = FieldNode | ConstNode | CallNode

export type XY = { x: number; y: number }

/** One named column in a feature set. `positions` is presentation only. */
export interface NamedExpr {
  id: string
  name: string
  expr: ExprNode
  positions: Record<string, XY>
}

let counter = 0

/**
 * Node ids are local to the browser session and never persisted — the record is
 * the rendered string. A counter rather than a uuid so a rebuilt tree lays out
 * identically twice in a row, which is what makes the layout tests meaningful.
 */
export const nextId = (prefix = 'n'): string => `${prefix}${++counter}`

export const field = (name: string): FieldNode => ({ id: nextId('f'), kind: 'field', name })

export const constant = (value: number): ConstNode => ({ id: nextId('c'), kind: 'const', value })

/**
 * Build a call node with every slot present — series slots null, params filled
 * from `params`. Slots are always present as keys so the card can render an empty
 * well for each one rather than inferring what is missing.
 */
export function call(
  spec: OperatorSpec,
  args: Record<string, ExprNode | null> = {},
  params: Record<string, number | null> = {},
): CallNode {
  const node: CallNode = { id: nextId('o'), kind: 'call', op: spec.name, args: {}, params: {} }
  for (const slot of spec.slots) {
    if (slot.kind === 'series') node.args[slot.name] = args[slot.name] ?? null
    else node.params[slot.name] = params[slot.name] ?? null
  }
  return node
}

/** Depth-first walk, parents before children. */
export function walk(node: ExprNode, visit: (n: ExprNode, parent: CallNode | null) => void,
                     parent: CallNode | null = null): void {
  visit(node, parent)
  if (node.kind !== 'call') return
  for (const child of Object.values(node.args)) {
    if (child) walk(child, visit, node)
  }
}

/** Every node in the tree, parents first. */
export function nodeList(root: ExprNode): ExprNode[] {
  const out: ExprNode[] = []
  walk(root, (n) => out.push(n))
  return out
}

/** True when no series slot is empty and no window/scalar is unset. */
export function isComplete(root: ExprNode): boolean {
  let ok = true
  walk(root, (n) => {
    if (n.kind !== 'call') return
    if (Object.values(n.args).some((a) => a === null)) ok = false
    if (Object.values(n.params).some((p) => p === null)) ok = false
  })
  return ok
}
