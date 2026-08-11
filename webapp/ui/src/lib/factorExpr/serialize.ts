/**
 * Tree -> qlib expression string.
 *
 * This is the half of the round trip that has to be canonical: two trees with
 * the same shape must render to the same string, or a saved feature set would
 * diff against itself. `parse` re-derives its parenthesisation from the same
 * precedence table in `registry.ts`, so the round trip is structural rather than
 * textual -- reformatting an expression is expected, changing its shape is not.
 *
 * Formatting rule, chosen once: no spaces around `*` `/` `**`, single spaces
 * around `+` `-` and the comparisons, no space after a comma. That reproduces
 * the curated catalog's own style for the entries it agrees with itself on.
 */
import type { CallNode, ExprNode, OperatorRegistry } from './types'

/** Stands in for an unfilled slot. Not valid qlib, and meant to be obvious. */
export const HOLE = '?'

/** Rendered when a node names an operator the registry has never heard of. */
const unknownOp = (op: string) => `${op}(?)`

const TIGHT = new Set(['*', '/', '**'])

function renderConst(value: number): string {
  // String() already gives qlib-compatible forms for both 20 and 1e-12.
  return String(value)
}

interface Ctx {
  registry: OperatorRegistry
  /** Precedence of the operator consuming this node; 0 at the root. */
  parentPrecedence: number
  /** Which side of that operator this node sits on. */
  side: 'left' | 'right' | 'none'
}

function renderNode(node: ExprNode | null, ctx: Ctx): string {
  if (node === null) return HOLE
  if (node.kind === 'field') return `$${node.name}`
  if (node.kind === 'const') return renderConst(node.value)

  const spec = ctx.registry[node.op]
  if (!spec) return unknownOp(node.op)

  if (!spec.symbol) {
    // Function form is self-bracketing, so it never needs parens of its own.
    const parts = spec.slots.map((slot) =>
      slot.kind === 'series'
        ? renderNode(node.args[slot.name] ?? null, { ...ctx, parentPrecedence: 0, side: 'none' })
        : paramText(node, slot.name))
    return `${spec.name}(${parts.join(',')})`
  }

  const precedence = spec.precedence ?? 0
  const left = renderNode(node.args.left ?? null,
                          { ...ctx, parentPrecedence: precedence, side: 'left' })
  const right = renderNode(node.args.right ?? null,
                           { ...ctx, parentPrecedence: precedence, side: 'right' })
  const gap = TIGHT.has(spec.symbol) ? '' : ' '
  const text = `${left}${gap}${spec.symbol}${gap}${right}`

  return needsParens(precedence, spec.rightAssociative ?? false, ctx) ? `(${text})` : text
}

function paramText(node: CallNode, slot: string): string {
  const value = node.params[slot]
  return value === null || value === undefined ? HOLE : renderConst(value)
}

/**
 * Parens only where dropping them would change the tree.
 *
 * Lower precedence inside higher always needs them. Equal precedence needs them
 * on whichever side associativity does *not* favour -- `$a-($b-$c)` keeps its
 * parens, `($a-$b)-$c` does not.
 */
function needsParens(precedence: number, rightAssociative: boolean, ctx: Ctx): boolean {
  if (ctx.parentPrecedence === 0) return false
  if (precedence < ctx.parentPrecedence) return true
  if (precedence > ctx.parentPrecedence) return false
  return rightAssociative ? ctx.side === 'left' : ctx.side === 'right'
}

/** The whole expression, as qlib would receive it. */
export function serialize(root: ExprNode | null, registry: OperatorRegistry): string {
  return renderNode(root, { registry, parentPrecedence: 0, side: 'none' })
}

/**
 * One node's own sub-expression, rendered as if it were the root. This is what
 * each card prints in its footer, so a reader can always see what the card in
 * front of them means without tracing edges.
 */
export const serializeNode = serialize

/** True when the rendered form still has an unfilled slot in it. */
export const hasHole = (text: string): boolean => text.includes(HOLE)
