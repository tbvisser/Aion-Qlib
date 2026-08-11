/**
 * A feature set at its boundaries: validated, serialised, and read back.
 *
 * Everything here is pure. The canvas holds trees; `StrategySpec.features` holds
 * `{name, expression}` strings; this is the only place that converts between
 * them, and the only place that decides whether a set is fit to run.
 *
 * The rule worth knowing is `base-collision`. In `extend` mode a custom column
 * that repeats one of the handler's own names does not error and does not add a
 * column — qlib's `NestedDataLoader` drops the earlier duplicate and keeps the
 * later one, so the handler comes back the same size with the user's expression
 * under qlib's name. The backend refuses it too; refusing it here as well is
 * what makes the message arrive while the name is being typed rather than when
 * Run is pressed.
 */
import { parse } from './parse'
import { serialize } from './serialize'
import { isComplete, type OperatorRegistry } from './types'
import type { FeatureColumn } from './featureSetReducer'

export type FeatureMode = 'extend' | 'replace'

/** One column as the strategy spec carries it, plus what the canvas knows. */
export interface FeatureDraft {
  id: string
  name: string
  expression: string
  complete: boolean
}

export type IssueCode =
  | 'invalid-name' | 'reserved-name' | 'duplicate-name' | 'case-clash'
  | 'base-collision' | 'incomplete' | 'empty-set'
  /**
   * The server's verdict on the expression itself.
   *
   * Everything above is about names and completeness, which the client can
   * decide alone. Lookahead, unbounded history and unknown fields are only
   * knowable against the operator registry and the store, so they arrive from
   * `/factors/validate` and are folded in here rather than living in a parallel
   * list the tab dots and the blocker count would not see.
   */
  | 'server-defect'

export interface FeatureIssue {
  /** null for an issue about the set rather than one column. */
  columnId: string | null
  level: 'error' | 'warning'
  code: IssueCode
  message: string
}

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Names qlib's own machinery would misread.
 *
 * `LABEL` is a prefix rather than an exact match because qlib's processors
 * select label columns with `str.contains("LABEL")`, so `LABEL_MOM` would be
 * treated as a label by any recipe that uses one.
 */
export const RESERVED = new Set(['label', 'feature'])

export function validateName(name: string): IssueCode | null {
  if (!NAME_PATTERN.test(name)) return 'invalid-name'
  if (RESERVED.has(name.toLowerCase())) return 'reserved-name'
  if (name.toUpperCase().startsWith('LABEL')) return 'reserved-name'
  return null
}

/** A name not already taken, e.g. `MA5` -> `MA5_2`. */
export function uniqueName(taken: Iterable<string>, base: string): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`
    if (!used.has(candidate)) return candidate
  }
}

export function toDraft(column: FeatureColumn, registry: OperatorRegistry): FeatureDraft {
  return {
    id: column.id,
    name: column.name,
    expression: serialize(column.expr, registry),
    complete: isComplete(column.expr),
  }
}

/**
 * The columns fit to go into `StrategySpec.features`.
 *
 * Complete ones only. An unfinished tree serialises with a `?` in it, which
 * would fail the debounced config preview on every keystroke and turn the whole
 * page red while the user is still building. They stay on the canvas and are
 * reported beside the Run button instead.
 */
export function toSpecFeatures(drafts: FeatureDraft[]): { name: string; expression: string }[] {
  return drafts.filter((d) => d.complete).map((d) => ({ name: d.name, expression: d.expression }))
}

/**
 * Read a saved feature set back into trees.
 *
 * An expression that will not parse is returned in `failures` rather than
 * dropped: the canvas must never silently delete a feature it could not draw,
 * because the user would save over it and lose it for good.
 */
export function fromSpecFeatures(
  features: { name: string; expression: string }[] | null | undefined,
  registry: OperatorRegistry,
  mintId: () => string,
): { columns: FeatureColumn[]; failures: { name: string; expression: string; message: string }[] } {
  const columns: FeatureColumn[] = []
  const failures: { name: string; expression: string; message: string }[] = []
  for (const feature of features ?? []) {
    const result = parse(feature.expression, registry)
    if (result.ok) {
      columns.push({ id: mintId(), name: feature.name, expr: result.node })
    } else {
      failures.push({ ...feature, message: result.error.message })
    }
  }
  return { columns, failures }
}

const issue = (columnId: string | null, level: 'error' | 'warning',
               code: IssueCode, message: string): FeatureIssue =>
  ({ columnId, level, code, message })

/**
 * Everything wrong with a feature set, worst first per column.
 *
 * `base` is the set of column names the chosen handler already computes, and it
 * only matters in `extend` mode -- in `replace` mode the handler's own features
 * are not there to collide with.
 */
export function validateFeatureSet(
  columns: FeatureColumn[],
  opts: { mode: FeatureMode; base: ReadonlySet<string>; handler?: string },
): FeatureIssue[] {
  const issues: FeatureIssue[] = []
  const seen = new Map<string, string>()
  const lowered = new Map<string, string>()
  const handler = opts.handler ?? 'the handler'

  for (const column of columns) {
    const nameProblem = validateName(column.name)
    if (nameProblem === 'invalid-name') {
      issues.push(issue(column.id, 'error', 'invalid-name',
        `“${column.name}” cannot be a column name. Use a letter or underscore `
        + 'first, then letters, digits or underscores.'))
    } else if (nameProblem === 'reserved-name') {
      issues.push(issue(column.id, 'error', 'reserved-name',
        `“${column.name}” is reserved. qlib picks out label columns by the word `
        + 'LABEL, so a feature named this way would be processed as one.'))
    } else if (seen.has(column.name)) {
      issues.push(issue(column.id, 'error', 'duplicate-name',
        `Two columns are called “${column.name}”. Names become pandas columns, `
        + 'so the second would overwrite the first.'))
    } else if (opts.mode === 'extend' && opts.base.has(column.name)) {
      issues.push(issue(column.id, 'error', 'base-collision',
        `“${column.name}” is already a column in ${handler}. Extending would `
        + `replace ${handler}'s ${column.name} with yours and nothing would `
        + 'report it — the loader keeps the later column and drops the earlier. '
        + 'Rename it, or switch to replace.'))
    } else if (lowered.has(column.name.toLowerCase())) {
      // Works, because qlib is case-sensitive. Still a trap in a list someone
      // has to read.
      issues.push(issue(column.id, 'warning', 'case-clash',
        `“${column.name}” differs from “${lowered.get(column.name.toLowerCase())}” `
        + 'only by case.'))
    }

    if (!isComplete(column.expr)) {
      // A warning, not an error, because it is genuinely not one:
      // `toSpecFeatures` already drops incomplete columns, so a half-built
      // column changes nothing about the run. Marking it an error meant that
      // clicking a single operator in the palette — which inserts a call with
      // empty slots, i.e. the normal way to build anything — greyed out Run,
      // while the alert beside it said unfinished columns are "not errors".
      // The copy and the serialiser agreed; only the severity did not.
      issues.push(issue(column.id, 'warning', 'incomplete',
        `“${column.name}” has an empty slot, so it is not in the config yet.`))
    }

    seen.set(column.name, column.id)
    lowered.set(column.name.toLowerCase(), column.name)
  }

  if (opts.mode === 'replace' && !columns.some((c) => isComplete(c.expr))) {
    issues.push(issue(null, 'error', 'empty-set',
      'Replacing the handler’s features needs at least one finished column, or '
      + 'there is nothing for the model to look at.'))
  }

  return issues
}

export const blocking = (issues: FeatureIssue[]): FeatureIssue[] =>
  issues.filter((i) => i.level === 'error')
