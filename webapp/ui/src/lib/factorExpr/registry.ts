/**
 * The operator vocabulary the canvas draws.
 *
 * Hardcoded for now, and deliberately not throwaway: once the backend serves a
 * registry introspected from `qlib.data.ops.OpsList`, this stays as the offline
 * fallback so the canvas still renders when the API is down or the store has not
 * been built. `mergeRegistry` is where the served one takes over.
 *
 * Nothing outside this file knows an operator's arity or which of its arguments
 * is a series versus a window. That is what keeps `Ref(x, 20)`'s judgement — the
 * 20 is a constructor argument, not an input — in one place.
 */
import type { OperatorRegistry, OperatorSpec } from './types'

/** Binding power. Higher binds tighter; mirrors Python's own table. */
export const PRECEDENCE = { compare: 1, additive: 2, multiplicative: 3, power: 4 } as const

const series = (name: string, label?: string) => ({ name, kind: 'series' as const, label })
const window = (name = 'N', label = 'window') => ({ name, kind: 'window' as const, label })

/**
 * The default rolling semantics, from qlib/data/ops.py:747-752.
 *
 * These hold for the Rolling subclasses and nothing else. `Ref` overrides
 * `_load_internal` entirely, and PairRolling has no EWM branch, so both get
 * their own below rather than sharing this.
 */
const ROLLING = { expandingAtZero: true, ewmBelowOne: true }

/** Corr/Cov expand at N=0 but reach `.rolling(0.5)` and raise below 1. */
const PAIR_ROLLING = { expandingAtZero: true, ewmBelowOne: false }

function infix(name: string, symbol: string, precedence: number, summary: string,
               category: OperatorSpec['category'] = 'arithmetic'): OperatorSpec {
  return {
    name, symbol, precedence, category, summary,
    slots: [series('left'), series('right')],
    rightAssociative: symbol === '**',
  }
}

function rolling(name: string, summary: string,
                 extra: Partial<OperatorSpec> = {}): OperatorSpec {
  return {
    name, category: 'rolling', summary,
    slots: [series('feature', 'series'), window()],
    window: ROLLING,
    ...extra,
  }
}

const OPERATORS: OperatorSpec[] = [
  infix('Add', '+', PRECEDENCE.additive, 'Add two series.'),
  infix('Sub', '-', PRECEDENCE.additive, 'Subtract the right from the left.'),
  infix('Mul', '*', PRECEDENCE.multiplicative, 'Multiply two series.'),
  infix('Div', '/', PRECEDENCE.multiplicative, 'Divide the left by the right.'),
  infix('Power', '**', PRECEDENCE.power, 'Raise the left to the right.'),

  infix('Gt', '>', PRECEDENCE.compare, 'True where the left exceeds the right.', 'compare'),
  infix('Ge', '>=', PRECEDENCE.compare, 'True where the left is at least the right.', 'compare'),
  infix('Lt', '<', PRECEDENCE.compare, 'True where the left is under the right.', 'compare'),
  infix('Le', '<=', PRECEDENCE.compare, 'True where the left is at most the right.', 'compare'),
  infix('Eq', '==', PRECEDENCE.compare, 'True where the two are equal.', 'compare'),
  infix('Ne', '!=', PRECEDENCE.compare, 'True where the two differ.', 'compare'),

  {
    name: 'Abs', category: 'elementwise', summary: 'Absolute value.',
    slots: [series('feature', 'series')],
  },
  {
    name: 'Log', category: 'elementwise', summary: 'Natural logarithm.',
    slots: [series('feature', 'series')],
  },
  {
    name: 'Sign', category: 'elementwise', summary: 'Sign: -1, 0 or 1.',
    slots: [series('feature', 'series')],
  },
  {
    name: 'Greater', category: 'elementwise',
    summary: 'The larger of two series, element by element.',
    slots: [series('left'), series('right')],
  },
  {
    name: 'Less', category: 'elementwise',
    summary: 'The smaller of two series, element by element.',
    slots: [series('left'), series('right')],
  },
  {
    name: 'If', category: 'logic',
    summary: 'Pick from two series according to a condition.',
    slots: [series('condition'), series('left', 'then'), series('right', 'else')],
  },
  // Offered as calls, never as `&`/`|`: Python binds those looser than the
  // comparisons, so `$a > 1 & $b > 1` groups as `$a > (1 & $b) > 1` and is
  // silently wrong. The parser already tells anyone who writes `and` to write
  // `And(...)` — before these existed it then refused its own suggestion.
  {
    name: 'And', category: 'logic', summary: 'True where both sides are true.',
    slots: [series('left'), series('right')],
  },
  {
    name: 'Or', category: 'logic', summary: 'True where either side is true.',
    slots: [series('left'), series('right')],
  },
  {
    name: 'Not', category: 'logic', summary: 'Flip a true/false series.',
    slots: [series('feature', 'series')],
  },

  // Rolling. `Ref` is the one operator that accepts a negative window -- and a
  // negative Ref in a *feature* is lookahead, which the backend validator
  // refuses. In a label it is exactly right.
  // Ref is a Rolling subclass that overrides _load_internal, so it shares none
  // of ROLLING's semantics: N=0 repeats the first observation rather than
  // expanding, and a fractional N is a shift, not an EWM alpha.
  //
  // A negative N reads the future. That is exactly right in a label and is
  // lookahead in a feature, and `POST /api/factors/validate` refuses the second
  // — see api/factorlab/expressions.py. (This comment used to claim a validator
  // that did not exist.)
  rolling('Ref', 'The series as it was N days ago.',
          { window: { expandingAtZero: false, ewmBelowOne: false, allowsNegative: true },
            slots: [series('feature', 'series'), window('N', 'days back')] }),
  rolling('Mean', 'Rolling mean over N days.'),
  rolling('Sum', 'Rolling sum over N days.'),
  rolling('Std', 'Rolling standard deviation over N days.'),
  rolling('Var', 'Rolling variance over N days.'),
  rolling('Max', 'Rolling maximum over N days.'),
  rolling('Min', 'Rolling minimum over N days.'),
  rolling('Med', 'Rolling median over N days.'),
  rolling('Mad', 'Rolling mean absolute deviation over N days.'),
  rolling('Rank', "Where today's value sits in the last N days, 0 to 1."),
  rolling('Delta', 'Change over N days.'),
  rolling('Slope', 'Slope of a line fitted through the last N days.'),
  rolling('Rsquare', 'Fit quality of that line, 0 to 1.'),
  rolling('Resi', 'Residual from that line.'),
  rolling('IdxMax', 'How many days ago the N-day maximum occurred.'),
  rolling('IdxMin', 'How many days ago the N-day minimum occurred.'),
  rolling('EMA', 'Exponentially weighted mean.'),
  rolling('WMA', 'Linearly weighted mean.'),
  rolling('Count', 'How many non-missing values in the last N days.'),
  // qlib raises below these windows rather than returning NaN --
  // qlib/data/ops.py:925 and :947. Kurt's guard is `N < 4` while the message it
  // raises says 5, so the number here is the guard, not the sentence.
  rolling('Skew', 'Rolling skewness. Needs at least 3 days.',
          { window: { ...ROLLING, min: 3 } }),
  rolling('Kurt', 'Rolling kurtosis. Needs at least 4 days.',
          { window: { ...ROLLING, min: 4 } }),

  {
    name: 'Corr', category: 'pair', summary: 'Rolling correlation of two series.',
    slots: [series('left'), series('right'), window()], window: PAIR_ROLLING,
  },
  {
    name: 'Cov', category: 'pair', summary: 'Rolling covariance of two series.',
    slots: [series('left'), series('right'), window()], window: PAIR_ROLLING,
  },
  {
    name: 'Quantile', category: 'rolling', summary: 'Rolling quantile over N days.',
    slots: [series('feature', 'series'), window(), { name: 'qscore', kind: 'scalar', label: 'quantile' }],
    window: ROLLING,
  },
]

export const FALLBACK_REGISTRY: OperatorRegistry =
  Object.fromEntries(OPERATORS.map((o) => [o.name, o]))

/** The columns every store on this machine holds. Replaced by the served list. */
export const FALLBACK_FIELDS = [
  'open', 'high', 'low', 'close', 'volume', 'factor', 'change',
]

export const CATEGORY_LABELS: Record<OperatorSpec['category'], string> = {
  arithmetic: 'Arithmetic',
  compare: 'Comparisons',
  rolling: 'Rolling windows',
  pair: 'Two-series windows',
  elementwise: 'Element by element',
  logic: 'Logic',
}

export const getOp = (registry: OperatorRegistry, name: string): OperatorSpec | undefined =>
  registry[name]

/**
 * Fold a served registry over the fallback. The served entry wins outright
 * rather than being merged field-by-field: a half-served operator whose slots
 * came from here and whose window semantics came from the server would be a
 * vocabulary neither side agreed to.
 */
export function mergeRegistry(served: OperatorRegistry | null): OperatorRegistry {
  return served ? { ...FALLBACK_REGISTRY, ...served } : FALLBACK_REGISTRY
}
