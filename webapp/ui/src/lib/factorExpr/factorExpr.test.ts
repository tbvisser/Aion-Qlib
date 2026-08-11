/**
 * The canvas must never silently change an expression.
 *
 * That is the failure that would make the whole feature untrustworthy: you open
 * a saved factor, the parser reads it slightly wrong, you save it back, and the
 * strategy now trades on rules nobody wrote. So the load-bearing test here is
 * the round trip -- parse, render, parse again, and assert the two trees have
 * the same shape.
 *
 * Structural equality, not textual: reformatting is expected (the serialiser has
 * one canonical spacing) and harmless. Changing the tree is neither.
 */
import { describe, expect, it } from 'vitest'

import { layoutTree, nodeHeight } from './layout'
import { parse } from './parse'
import { FALLBACK_REGISTRY as registry } from './registry'
import { serialize } from './serialize'
import { firstEmptySlot, insertBlock, replaceOp, setParam } from './tree'
import { call, constant, field, isComplete, nodeList, type ExprNode } from './types'

/** The tree with ids stripped, so two structurally equal trees compare equal. */
function shape(node: ExprNode): unknown {
  if (node.kind === 'field') return { field: node.name }
  if (node.kind === 'const') return { const: node.value }
  return {
    op: node.op,
    args: Object.fromEntries(
      Object.entries(node.args).map(([k, v]) => [k, v ? shape(v) : null])),
    params: node.params,
  }
}

const read = (source: string): ExprNode => {
  const result = parse(source, registry)
  if (!result.ok) throw new Error(`${source} -> ${result.error.message}`)
  return result.node
}

const render = (node: ExprNode) => serialize(node, registry)

/**
 * The curated catalog from webapp/api/routers/factors.py:34-58. If an entry
 * there changes, this list is the thing that should be updated with it.
 */
const CATALOG = [
  'Ref($close,20)/$close - 1',
  'Mean($close,5)/Mean($close,20) - 1',
  '($close-Min($low,20))/(Max($high,20)-Min($low,20)+1e-12)',
  '-1 * ($close/Ref($close,5) - 1)',
  'Std($close/Ref($close,1)-1,20)',
  'Slope($close,20)/$close',
  '$volume/(Mean($volume,20)+1e-12)',
  'Corr($close,$volume,20)',
  '($high-$low)/$close',
  '($close-$open)/$open',
]

describe('round trip', () => {
  it.each(CATALOG)('%s survives parse -> render -> parse', (source) => {
    const once = read(source)
    const twice = read(render(once))
    expect(shape(twice)).toEqual(shape(once))
  })

  it.each(CATALOG)('%s reaches a fixed point after one render', (source) => {
    // Rendering is canonical, so the second render must be byte-identical to
    // the first even when the source was formatted differently.
    const rendered = render(read(source))
    expect(render(read(rendered))).toBe(rendered)
  })

  it('every catalog entry parses into a complete tree', () => {
    for (const source of CATALOG) expect(isComplete(read(source))).toBe(true)
  })
})

describe('parenthesisation', () => {
  const cases: [string, string][] = [
    // Parens that carry meaning are kept...
    ['($a+$b)*$c', '($a + $b)*$c'],
    ['$a-($b-$c)', '$a - ($b - $c)'],
    ['$a/($b*$c)', '$a/($b*$c)'],
    ['($a-$b)/($c+$d)', '($a - $b)/($c + $d)'],
    ['($a>$b)*$c', '($a > $b)*$c'],
    // ...and parens that do not are dropped.
    ['$a+($b*$c)', '$a + $b*$c'],
    ['($a*$b)+$c', '$a*$b + $c'],
    ['($a-$b)-$c', '$a - $b - $c'],
    ['(($a))', '$a'],
    ['$a+$b+$c', '$a + $b + $c'],
  ]
  it.each(cases)('%s renders as %s', (source, expected) => {
    expect(render(read(source))).toBe(expected)
  })

  it('keeps ** right-associative', () => {
    // 2**(3**4), not (2**3)**4 -- so the left side is the one needing parens.
    expect(render(read('2**3**4'))).toBe('2**3**4')
    expect(render(read('(2**3)**4'))).toBe('(2**3)**4')
    expect(shape(read('2**3**4'))).toEqual(shape(read('2**(3**4)')))
  })
})

describe('what qlib cannot express is refused, not mangled', () => {
  it('refuses a leading minus on an expression, naming the repair', () => {
    const result = parse('-($close - 1)', registry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('-1 * (...)')
  })

  it('accepts a negative literal, which is how the catalog writes it', () => {
    expect(render(read('-1 * $close'))).toBe('-1*$close')
    expect(shape(read('-1'))).toEqual({ const: -1 })
  })

  it.each(['and', 'or', 'not'])('refuses the Python keyword `%s`', (keyword) => {
    const result = parse(`$close ${keyword} $open`, registry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toMatch(/And|Or|Not/)
  })

  it('refuses a chained comparison', () => {
    const result = parse('$low < $close < $high', registry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('chained')
  })

  it('refuses point-in-time fields, which these stores do not hold', () => {
    expect(parse('$$roe', registry).ok).toBe(false)
  })

  it('refuses an expression where a window belongs', () => {
    const result = parse('Mean($close,$volume)', registry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('must be a number')
  })

  it.each([
    ['Mean($close)', 'takes 2 arguments'],
    ['Nope($close,5)', 'no operator called'],
    ['Ref($close,', 'ends early'],
    ['$close +', 'ends early'],
    ['', 'Nothing to parse'],
  ])('reports %s', (source, fragment) => {
    const result = parse(source, registry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain(fragment)
  })
})

describe('unfinished expressions still render', () => {
  it('marks an empty slot rather than throwing', () => {
    const node = call(registry.Mean, {}, {})
    expect(render(node)).toBe('Mean(?,?)')
    expect(isComplete(node)).toBe(false)
  })

  it('a filled window still leaves the series hole visible', () => {
    const node = setParam(call(registry.Mean, {}, {}), '', 'N', 20)
    expect(render(node)).toContain('?')
  })
})

describe('tree edits', () => {
  it('keeps children when the operator is swapped', () => {
    const before = read('Mean($close,20)')
    const after = replaceOp(before, before.id, registry.Std, registry)
    expect(render(after)).toBe('Std($close,20)')
  })

  it('drops what the new operator has no room for, and says so by dropping it', () => {
    const before = read('Corr($close,$volume,20)')
    const after = replaceOp(before, before.id, registry.Mean, registry)
    // Mean has one series slot; $volume has nowhere to go.
    expect(render(after)).toBe('Mean($close,20)')
  })

  it('wraps the selection when it has no empty slot', () => {
    const root = read('$close')
    const wrapped = insertBlock(root, root.id, call(registry.Mean), registry)
    expect(render(wrapped)).toBe('Mean($close,?)')
  })

  it('fills the selection`s empty slot rather than wrapping it', () => {
    const root = read('Corr($close,$volume,20)')
    const emptied = insertBlock(root, root.id, field('high'), registry)
    // Nothing is empty, so a leaf replaces the selected node instead.
    expect(render(emptied)).toBe('$high')

    const partial = call(registry.Corr, { left: field('close') }, { N: 20 })
    const filled = insertBlock(partial, partial.id, field('volume'), registry)
    expect(render(filled)).toBe('Corr($close,$volume,20)')
  })

  it('finds the first empty slot depth first', () => {
    const node = read('Mean($close,20)/$close')
    expect(firstEmptySlot(node, registry)).toBeNull()

    const partial = call(registry.Div, { left: field('close') })
    expect(firstEmptySlot(partial, registry)).toEqual({ nodeId: partial.id, slot: 'right' })
  })
})

describe('layout', () => {
  const tree = read('Ref($close,20)/$close - 1')

  it('places every node exactly once', () => {
    const positions = layoutTree(tree, registry)
    expect(Object.keys(positions).length).toBe(nodeList(tree).length)
  })

  it('is deterministic', () => {
    expect(layoutTree(tree, registry)).toEqual(layoutTree(tree, registry))
  })

  it('puts the root on the right and leaves on the left', () => {
    const positions = layoutTree(tree, registry)
    const xs = Object.values(positions).map((p) => p.x)
    expect(positions[tree.id].x).toBe(Math.max(...xs))
    expect(Math.min(...xs)).toBe(0)
  })

  it('never overlaps two cards', () => {
    const positions = layoutTree(tree, registry)
    const boxes = nodeList(tree).map((n) => ({
      ...positions[n.id], h: nodeHeight(n, registry),
    }))
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]
        const b = boxes[j]
        const overlaps = a.x === b.x && a.y < b.y + b.h && b.y < a.y + a.h
        expect(overlaps).toBe(false)
      }
    }
  })
})

describe('serialising a constant', () => {
  it.each([[20, '20'], [1e-12, '1e-12'], [0.5, '0.5'], [-1, '-1']])(
    '%s renders as %s', (value, expected) => {
      expect(render(constant(value as number))).toBe(expected)
    })
})
