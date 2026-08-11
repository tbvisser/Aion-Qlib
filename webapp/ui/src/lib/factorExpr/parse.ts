/**
 * qlib expression string -> tree.
 *
 * A parser is unavoidable rather than a nicety: the curated catalog arrives as
 * strings, so do saved strategies and anything the chat agent writes. Without
 * this, the canvas can only ever build expressions, never open one.
 *
 * Precedence comes from the same table `serialize` parenthesises with
 * (`registry.ts`), so the round trip is structural. That is the property worth
 * protecting -- reformatting an expression is fine, changing its shape is not,
 * and the vitest suite asserts exactly that over every catalog entry.
 *
 * Two things are refused rather than mangled, both because qlib itself cannot
 * express them:
 *
 *   -(...)     qlib compiles with eval() over operator objects, so a leading
 *              minus on a sub-expression raises "bad operand type for unary -".
 *              The repair named here is the same one the backend's `_explain`
 *              gives, so the two messages cannot drift.
 *   a and b    Python's `and`/`or`/`not` and chained comparisons fold through
 *              __bool__, which qlib's Expression does not define -- it evaluates
 *              to a silently wrong scalar rather than failing.
 */
import { PRECEDENCE } from './registry'
import type { ExprNode, OperatorRegistry } from './types'
import { call, constant, field } from './types'

export interface ParseError {
  message: string
  /** Index into the source string, for a caret. */
  position: number
}

export type ParseResult =
  | { ok: true; node: ExprNode }
  | { ok: false; error: ParseError }

interface Token {
  kind: 'field' | 'number' | 'name' | 'op' | 'punct'
  text: string
  position: number
}

const BINARY: Record<string, { op: string; precedence: number; right?: boolean }> = {
  '**': { op: 'Power', precedence: PRECEDENCE.power, right: true },
  '*': { op: 'Mul', precedence: PRECEDENCE.multiplicative },
  '/': { op: 'Div', precedence: PRECEDENCE.multiplicative },
  '+': { op: 'Add', precedence: PRECEDENCE.additive },
  '-': { op: 'Sub', precedence: PRECEDENCE.additive },
  '>=': { op: 'Ge', precedence: PRECEDENCE.compare },
  '<=': { op: 'Le', precedence: PRECEDENCE.compare },
  '==': { op: 'Eq', precedence: PRECEDENCE.compare },
  '!=': { op: 'Ne', precedence: PRECEDENCE.compare },
  '>': { op: 'Gt', precedence: PRECEDENCE.compare },
  '<': { op: 'Lt', precedence: PRECEDENCE.compare },
}

/** Longest first, so `>=` is never read as `>` followed by `=`. */
const OPERATOR_TEXT = Object.keys(BINARY).sort((a, b) => b.length - a.length)

const KEYWORD_REPAIR: Record<string, string> = { and: 'And', or: 'Or', not: 'Not' }

/**
 * Report a token that has no place here.
 *
 * Python's boolean keywords get their own message wherever they turn up, not
 * just in operand position: `$close and $open` parses fine right up to `and`,
 * and "Unexpected `and`" would leave the reader with no idea that `And(...)`
 * is the thing they wanted.
 */
function unexpected(token: Token): never {
  const repair = KEYWORD_REPAIR[token.text]
  if (repair) {
    fail(`\`${token.text}\` is a Python keyword qlib evaluates to the wrong `
         + `thing. Write \`${repair}(...)\` instead.`, token.position)
  }
  fail(`Unexpected \`${token.text}\`.`, token.position)
}

class Bail extends Error {
  constructor(readonly detail: ParseError) {
    super(detail.message)
  }
}

function fail(message: string, position: number): never {
  throw new Bail({ message, position })
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (/\s/.test(ch)) { i += 1; continue }

    if (ch === '$') {
      const match = /^\$\$?[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))
      if (!match) fail('Expected a column name after `$`, e.g. `$close`.', i)
      tokens.push({ kind: 'field', text: match[0], position: i })
      i += match[0].length
      continue
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i))!
      tokens.push({ kind: 'number', text: match[0], position: i })
      i += match[0].length
      continue
    }

    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))!
      tokens.push({ kind: 'name', text: match[0], position: i })
      i += match[0].length
      continue
    }

    if ('(),'.includes(ch)) {
      tokens.push({ kind: 'punct', text: ch, position: i })
      i += 1
      continue
    }

    const operator = OPERATOR_TEXT.find((o) => source.startsWith(o, i))
    if (operator) {
      tokens.push({ kind: 'op', text: operator, position: i })
      i += operator.length
      continue
    }

    fail(`Unexpected character \`${ch}\`.`, i)
  }
  return tokens
}

class Parser {
  private at = 0

  constructor(private readonly tokens: Token[], private readonly registry: OperatorRegistry,
              private readonly length: number) {}

  private peek(): Token | undefined { return this.tokens[this.at] }

  private next(): Token | undefined { return this.tokens[this.at++] }

  private position(): number {
    return this.peek()?.position ?? this.length
  }

  private expect(text: string): Token {
    const token = this.peek()
    if (!token || token.text !== text) {
      fail(`Expected \`${text}\`.`, this.position())
    }
    return this.next()!
  }

  parse(): ExprNode {
    const node = this.expression(0)
    const extra = this.peek()
    if (extra) unexpected(extra)
    return node
  }

  private expression(minPrecedence: number): ExprNode {
    let left = this.unary()
    for (;;) {
      const token = this.peek()
      if (!token || token.kind !== 'op') break
      const binary = BINARY[token.text]
      if (!binary || binary.precedence < minPrecedence) break

      const spec = this.registry[binary.op]
      if (!spec) fail(`This build has no \`${binary.op}\` operator.`, token.position)
      this.next()

      const right = this.expression(
        binary.right ? binary.precedence : binary.precedence + 1)
      // Comparisons do not chain: `$a < $b < $c` is a Python-ism qlib evaluates
      // to something silently wrong rather than refusing.
      if (binary.precedence === PRECEDENCE.compare) {
        const following = this.peek()
        if (following?.kind === 'op' && BINARY[following.text]?.precedence === PRECEDENCE.compare) {
          fail('Comparisons cannot be chained. Combine them with `And(...)`.',
               following.position)
        }
      }
      left = call(spec, { left, right })
    }
    return left
  }

  private unary(): ExprNode {
    const token = this.peek()
    if (token?.kind === 'op' && token.text === '-') {
      this.next()
      const operand = this.unary()
      if (operand.kind === 'const') return constant(-operand.value)
      fail('qlib cannot apply a leading minus to an expression. '
           + 'Write `-1 * (...)` instead of `-(...)`.', token.position)
    }
    return this.primary()
  }

  private primary(): ExprNode {
    const token = this.next()
    if (!token) fail('The expression ends early.', this.length)

    if (token.kind === 'field') {
      if (token.text.startsWith('$$')) {
        fail('Point-in-time fields (`$$`) are not available in these stores.',
             token.position)
      }
      return field(token.text.slice(1))
    }

    if (token.kind === 'number') return constant(Number(token.text))

    if (token.text === '(') {
      const inner = this.expression(0)
      this.expect(')')
      return inner
    }

    if (token.kind === 'name') {
      if (token.text in KEYWORD_REPAIR) unexpected(token)
      return this.callNode(token)
    }

    unexpected(token)
  }

  private callNode(name: Token): ExprNode {
    const spec = this.registry[name.text]
    if (!spec) fail(`There is no operator called \`${name.text}\`.`, name.position)
    this.expect('(')

    const args: ExprNode[] = []
    if (this.peek()?.text !== ')') {
      for (;;) {
        args.push(this.expression(0))
        if (this.peek()?.text !== ',') break
        this.next()
      }
    }
    this.expect(')')

    if (args.length !== spec.slots.length) {
      fail(`\`${spec.name}\` takes ${spec.slots.length} argument`
           + `${spec.slots.length === 1 ? '' : 's'}, got ${args.length}.`, name.position)
    }

    const series: Record<string, ExprNode> = {}
    const params: Record<string, number> = {}
    spec.slots.forEach((slot, i) => {
      const arg = args[i]
      if (slot.kind === 'series') {
        series[slot.name] = arg
        return
      }
      // A window is a constructor argument, not a series -- qlib's rolling
      // operators take a number and cannot take an expression.
      if (arg.kind !== 'const') {
        fail(`\`${spec.name}\`'s \`${slot.label ?? slot.name}\` must be a number.`,
             name.position)
      }
      params[slot.name] = arg.value
    })
    return call(spec, series, params)
  }
}

export function parse(source: string, registry: OperatorRegistry): ParseResult {
  try {
    const trimmed = source.trim()
    if (!trimmed) return { ok: false, error: { message: 'Nothing to parse.', position: 0 } }
    const tokens = tokenize(trimmed)
    return { ok: true, node: new Parser(tokens, registry, trimmed.length).parse() }
  } catch (e) {
    if (e instanceof Bail) return { ok: false, error: e.detail }
    throw e
  }
}
