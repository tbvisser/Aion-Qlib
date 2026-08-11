/**
 * The feature set: its undo model, its validation, and its round trip.
 *
 * Two tests here carry most of the weight.
 *
 * `fromSpecFeatures(toSpecFeatures(...))` over all 184 library expressions is
 * the set-level analogue of the single-expression round trip, and it is what
 * proves a saved strategy reopens as the same canvas rather than a subtly
 * different one.
 *
 * The reducer purity test is what keeps `nextId()` out of the reducer. React
 * invokes reducers twice under StrictMode in development, so an id-minting
 * reducer would burn ids and produce two different states from one dispatch —
 * a bug that only shows up in dev, intermittently, in a way that looks like a
 * rendering problem.
 */
import { describe, expect, it } from 'vitest'

import library from '@/fixtures/library.json'
import { ALPHA158_COLUMNS, alpha360Columns, baseColumns } from './baseColumns'
import {
  blocking, fromSpecFeatures, toDraft, toSpecFeatures, uniqueName, validateFeatureSet,
  validateName,
} from './featureSet'
import {
  activeColumn, featureSetReducer, initialFeatureSet,
  type FeatureColumn, type FeatureSetState,
} from './featureSetReducer'
import { parse } from './parse'
import { mergeRegistry } from './registry'
import { serialize } from './serialize'
import type { Indicator } from '@/lib/api'
import served from '@/fixtures/registry.json'
import { call, constant, nextId, type ExprNode, type OperatorRegistry } from './types'

const registry = mergeRegistry(served.operators as unknown as OperatorRegistry)

const INDICATORS = library.indicators as { name: string; expression: string
                                           in_handler: boolean }[]

const read = (source: string): ExprNode => {
  const result = parse(source, registry)
  if (!result.ok) throw new Error(`${source} -> ${result.error.message}`)
  return result.node
}

const column = (name: string, source = '$close'): FeatureColumn =>
  ({ id: nextId('col'), name, expr: read(source) })

/** A tree with an empty slot. */
const unfinished = (): ExprNode => call(registry.Mean, {}, { N: 5 })

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

const start = (...names: string[]): FeatureSetState =>
  initialFeatureSet(names.map((n) => column(n)))

// --------------------------------------------------------------------------
// The reducer
// --------------------------------------------------------------------------

describe('the feature set reducer', () => {
  it('edits one column and leaves the others referentially identical', () => {
    // The structural-sharing claim that makes whole-set snapshots affordable.
    // Asserting identity, not equality, is the point.
    const before = start('A', 'B', 'C')
    const after = featureSetReducer(before, {
      type: 'edit', columnId: before.present.columns[1].id,
      apply: () => read('$open'),
    })
    expect(after.present.columns[0]).toBe(before.present.columns[0])
    expect(after.present.columns[2]).toBe(before.present.columns[2])
    expect(after.present.columns[1]).not.toBe(before.present.columns[1])
  })

  it('does not record an edit that changed nothing', () => {
    const before = start('A')
    const after = featureSetReducer(before, {
      type: 'edit', columnId: before.present.activeId, apply: (c) => c,
    })
    expect(after).toBe(before)
    expect(after.past).toHaveLength(0)
  })

  it('makes removing a column undoable, at its original index', () => {
    // The reason undo is global rather than per column: a deleted column has no
    // history of its own left to restore it from.
    let state = start('A', 'B', 'C')
    const target = state.present.columns[1]
    state = featureSetReducer(state, { type: 'remove', columnId: target.id })
    expect(state.present.columns.map((c) => c.name)).toEqual(['A', 'C'])

    state = featureSetReducer(state, { type: 'undo' })
    expect(state.present.columns.map((c) => c.name)).toEqual(['A', 'B', 'C'])
    expect(state.present.columns[1]).toBe(target)
  })

  it('refuses to remove the last column', () => {
    const before = start('A')
    expect(featureSetReducer(before, {
      type: 'remove', columnId: before.present.activeId,
    })).toBe(before)
  })

  it('activates the left neighbour when the active column is removed', () => {
    let state = start('A', 'B', 'C')
    state = featureSetReducer(state, { type: 'activate', columnId: state.present.columns[2].id })
    state = featureSetReducer(state, { type: 'remove', columnId: state.present.columns[2].id })
    expect(activeColumn(state)!.name).toBe('B')
  })

  it('takes you back to the column whose edit is being undone', () => {
    // You should never be shown a change you cannot see.
    let state = start('A', 'B')
    const [a, b] = state.present.columns
    state = featureSetReducer(state, {
      type: 'edit', columnId: a.id, apply: () => read('$open'),
    })
    state = featureSetReducer(state, { type: 'activate', columnId: b.id })
    state = featureSetReducer(state, { type: 'undo' })
    expect(state.present.activeId).toBe(a.id)
  })

  it('does not put tab switching on the undo stack', () => {
    let state = start('A', 'B')
    state = featureSetReducer(state, { type: 'activate', columnId: state.present.columns[1].id })
    expect(state.past).toHaveLength(0)
  })

  it('coalesces a run of renames on one column', () => {
    let state = start('A', 'B')
    const id = state.present.columns[0].id
    for (const name of ['M', 'MO', 'MOM']) {
      state = featureSetReducer(state, { type: 'rename', columnId: id, name })
    }
    expect(state.present.columns[0].name).toBe('MOM')
    expect(state.past).toHaveLength(1)

    state = featureSetReducer(state, { type: 'undo' })
    expect(state.present.columns[0].name).toBe('A')
  })

  it('does not coalesce renames across different columns', () => {
    let state = start('A', 'B')
    const [a, b] = state.present.columns
    state = featureSetReducer(state, { type: 'rename', columnId: a.id, name: 'X' })
    state = featureSetReducer(state, { type: 'rename', columnId: b.id, name: 'Y' })
    expect(state.past).toHaveLength(2)
  })

  it('breaks a rename run when an edit happens in between', () => {
    let state = start('A')
    const id = state.present.columns[0].id
    state = featureSetReducer(state, { type: 'rename', columnId: id, name: 'X' })
    state = featureSetReducer(state, { type: 'edit', columnId: id, apply: () => read('$open') })
    state = featureSetReducer(state, { type: 'rename', columnId: id, name: 'XY' })
    expect(state.past).toHaveLength(3)
  })

  it('caps history and drops the oldest snapshot', () => {
    let state = start('A')
    const id = state.present.columns[0].id
    for (let i = 0; i < 120; i++) {
      state = featureSetReducer(state, {
        type: 'edit', columnId: id, apply: () => constant(i),
      })
    }
    expect(state.past).toHaveLength(100)
  })

  it('clears the redo stack on a new edit', () => {
    let state = start('A')
    const id = state.present.columns[0].id
    state = featureSetReducer(state, { type: 'edit', columnId: id, apply: () => read('$open') })
    state = featureSetReducer(state, { type: 'undo' })
    expect(state.future).toHaveLength(1)
    state = featureSetReducer(state, { type: 'edit', columnId: id, apply: () => read('$high') })
    expect(state.future).toHaveLength(0)
  })

  it('makes reordering undoable and keeps the active column', () => {
    let state = start('A', 'B', 'C')
    const active = state.present.activeId
    state = featureSetReducer(state, { type: 'reorder', from: 0, to: 2 })
    expect(state.present.columns.map((c) => c.name)).toEqual(['B', 'C', 'A'])
    expect(state.present.activeId).toBe(active)
    state = featureSetReducer(state, { type: 'undo' })
    expect(state.present.columns.map((c) => c.name)).toEqual(['A', 'B', 'C'])
  })

  it('clears both stacks on reseed', () => {
    // A set pushed in from outside is a new document. Undoing across that
    // boundary would resurrect columns from a different strategy.
    let state = start('A')
    state = featureSetReducer(state, {
      type: 'edit', columnId: state.present.activeId, apply: () => read('$open'),
    })
    state = featureSetReducer(state, { type: 'reseed', columns: [column('Z')] })
    expect(state.past).toHaveLength(0)
    expect(state.future).toHaveLength(0)
    expect(state.present.columns.map((c) => c.name)).toEqual(['Z'])
  })

  it('is pure, and never mints an id', () => {
    // React invokes reducers twice under StrictMode. A reducer that called
    // nextId() would burn ids and return two different states for one dispatch.
    const before = Object.freeze(start('A', 'B'))
    const action = { type: 'add' as const, column: column('C') }
    const once = featureSetReducer(before, action)
    const twice = featureSetReducer(before, action)
    expect(once).toEqual(twice)
    expect(once.present.columns[2].id).toBe(twice.present.columns[2].id)
  })
})

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

const validate = (columns: FeatureColumn[], mode: 'extend' | 'replace' = 'extend') =>
  validateFeatureSet(columns, {
    mode, base: new Set(ALPHA158_COLUMNS), handler: 'Alpha158',
  })

describe('validating a feature set', () => {
  it('refuses a name the handler already uses, and says what would happen', () => {
    const issues = validate([column('MA5')])
    expect(issues.map((i) => i.code)).toEqual(['base-collision'])
    expect(issues[0].message).toContain('replace')
    expect(issues[0].level).toBe('error')
  })

  it('allows that same name in replace mode', () => {
    // Nothing to collide with — the handler's own features are not there.
    expect(validate([column('MA5')], 'replace')).toEqual([])
  })

  it.each(['5MA', 'my ma', '$close', 'Ref($close,5)', ''])(
    'refuses %o as a column name', (name) => {
      expect(validateName(name)).toBe('invalid-name')
    })

  it.each(['label', 'LABEL', 'LABEL0', 'LABEL_MOM', 'feature'])(
    'refuses the reserved name %o', (name) => {
      expect(validateName(name)).toBe('reserved-name')
    })

  it('flags a duplicate on the later column only', () => {
    const columns = [column('MOM'), column('MOM')]
    const issues = validate(columns).filter((i) => i.code === 'duplicate-name')
    expect(issues).toHaveLength(1)
    expect(issues[0].columnId).toBe(columns[1].id)
  })

  it('treats a case clash as a warning, not an error', () => {
    // qlib is case-sensitive, so it works. It is still a trap to read.
    const issues = validate([column('MOM'), column('mom')])
    const clash = issues.find((i) => i.code === 'case-clash')
    expect(clash?.level).toBe('warning')
    expect(blocking(issues)).toEqual([])
  })

  it('reports an unfinished column through isComplete, not a string search', () => {
    const columns = [{ id: 'x', name: 'HOLE', expr: unfinished() }]
    expect(validate(columns).map((i) => i.code)).toContain('incomplete')
  })

  it('treats an unfinished column as a warning, so it cannot block a run', () => {
    // `toSpecFeatures` already drops it, so it changes nothing about the run.
    // As an error it disabled Run the moment you clicked a single operator —
    // which is the normal way to start building one.
    const columns = [{ id: 'x', name: 'HOLE', expr: unfinished() }]
    const issues = validate(columns)
    expect(issues.find((i) => i.code === 'incomplete')?.level).toBe('warning')
    expect(blocking(issues)).toEqual([])
  })

  it('still refuses a replace set with nothing finished in it', () => {
    // The one case where unfinished really is fatal: replace mode with no
    // finished column leaves the model nothing at all to look at.
    const columns = [{ id: 'x', name: 'HOLE', expr: unfinished() }]
    const issues = validate(columns, 'replace')
    expect(issues.map((i) => i.code)).toContain('empty-set')
    expect(blocking(issues).map((i) => i.code)).toEqual(['empty-set'])
  })

  it('accepts an ordinary set', () => {
    expect(validate([column('MOM_RATIO', 'Mean($close,5)/Mean($close,20) - 1'),
                     column('VOL_RATIO', '$volume/(Mean($volume,20)+1e-12)')])).toEqual([])
  })
})

describe('uniqueName', () => {
  it('leaves a free name alone and suffixes a taken one', () => {
    expect(uniqueName(['F1', 'F2'], 'F3')).toBe('F3')
    expect(uniqueName(['MA5'], 'MA5')).toBe('MA5_2')
    expect(uniqueName(['MA5', 'MA5_2'], 'MA5')).toBe('MA5_3')
  })
})

// --------------------------------------------------------------------------
// The boundary
// --------------------------------------------------------------------------

describe('the spec boundary', () => {
  it('round-trips all 184 library expressions through a feature set', () => {
    // The load-bearing test: a saved strategy must reopen as the same canvas.
    const columns = INDICATORS.map((i) => ({
      id: nextId('col'), name: i.name, expr: read(i.expression),
    }))
    const drafts = columns.map((c) => toDraft(c, registry))
    const spec = toSpecFeatures(drafts)
    expect(spec).toHaveLength(184)

    const { columns: back, failures } = fromSpecFeatures(spec, registry, () => nextId('col'))
    expect(failures).toEqual([])
    expect(back).toHaveLength(184)
    back.forEach((restored, i) => {
      expect(restored.name, restored.name).toBe(columns[i].name)
      expect(shape(restored.expr), restored.name).toEqual(shape(columns[i].expr))
    })
  })

  it('keeps an unparseable expression instead of dropping it', () => {
    // Silently deleting a feature the canvas cannot draw would lose it for good
    // the next time the user saves.
    const { columns, failures } = fromSpecFeatures(
      [{ name: 'GOOD', expression: '$close' },
       { name: 'BAD', expression: 'Momentum($close, 5)' }],
      registry, () => nextId('col'))
    expect(columns.map((c) => c.name)).toEqual(['GOOD'])
    expect(failures.map((f) => f.name)).toEqual(['BAD'])
    expect(failures[0].message).toContain('Momentum')
  })

  it('sends only finished columns to the spec', () => {
    // An unfinished tree serialises with a `?`, which would 422 the debounced
    // config preview on every keystroke.
    const drafts = [
      toDraft(column('DONE', 'Mean($close,5)'), registry),
      toDraft({ id: 'x', name: 'HOLE', expr: unfinished() }, registry),
    ]
    expect(toSpecFeatures(drafts).map((f) => f.name)).toEqual(['DONE'])
  })

  it('serialises a draft the way the canvas renders it', () => {
    const c = column('X', 'Mean($close,5)/Mean($close,20) - 1')
    expect(toDraft(c, registry).expression).toBe(serialize(c.expr, registry))
  })
})

// --------------------------------------------------------------------------
// Base columns
// --------------------------------------------------------------------------

describe('baseColumns', () => {
  it('matches the fixture, so the built-in list cannot rot', () => {
    const trained = INDICATORS.filter((i) => i.in_handler).map((i) => i.name)
    expect([...ALPHA158_COLUMNS].sort()).toEqual([...trained].sort())
    expect(ALPHA158_COLUMNS).toHaveLength(158)
  })

  it('knows the names that trip people up', () => {
    // qlib's `LOW` rolling key emits MIN, so MIN5 is a rolling column and LOW5
    // does not exist at all.
    expect(ALPHA158_COLUMNS).toContain('MIN5')
    expect(ALPHA158_COLUMNS).not.toContain('LOW5')
    expect(ALPHA158_COLUMNS).toContain('KMID')
    expect(ALPHA158_COLUMNS).toContain('VSUMD60')
    // The whole volume family is outside the handler.
    expect(ALPHA158_COLUMNS).not.toContain('VOLUME0')
  })

  it('never returns an empty set when the API has not answered', () => {
    // A collision check that passes because the backend was down is the worst
    // outcome available here.
    expect(baseColumns('Alpha158', []).size).toBe(158)
  })

  it('prefers the served answer once it arrives', () => {
    const served: Indicator[] = [
      { name: 'ONLY_ONE', in_handler: true } as Indicator,
      { name: 'NOT_IT', in_handler: false } as Indicator,
    ]
    expect([...baseColumns('Alpha158', served)]).toEqual(['ONLY_ONE'])
  })

  it('gives Alpha360 sixty lags of six fields and no rolling name', () => {
    const columns = baseColumns('Alpha360', [])
    expect(columns.size).toBe(360)
    expect(columns.has('CLOSE59')).toBe(true)
    // The fact that matters: MA5 collides under Alpha158 and is free here.
    expect(columns.has('MA5')).toBe(false)
    expect(alpha360Columns()).toHaveLength(360)
  })
})
