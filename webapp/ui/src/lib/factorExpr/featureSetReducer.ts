/**
 * A feature set: several named expression trees, and one undo stack over all of them.
 *
 * The canvas used to hold exactly one anonymous expression, which meant it could
 * teach the language but could not produce anything runnable — a strategy's
 * feature set is a *list* of named columns. `NamedExpr` has sat unused in
 * `types.ts` since the beginning waiting for this.
 *
 * Undo is a stack of whole snapshots rather than a log of reversible operations,
 * which stays affordable for the same reason it always did: every edit in
 * `tree.ts` shares all the untouched subtrees, so a snapshot costs the path that
 * changed plus N pointers, not N expressions.
 *
 * **Undo is global over the set, not per column.** Deleting a column has to be
 * undoable, and only a set-level stack can hold the column that no longer exists
 * to own its own history. It also matches what Cmd-Z means to a person: take
 * back the last thing I did, not the last thing I did in this tab.
 *
 * **Positions and selection are not in here.** They are canvas state, not
 * document state, and the original hook's rule holds: moving a card is not an
 * edit to the expression and must never land on the undo stack, or dragging a
 * node would bury the change you actually wanted to take back. Keeping them out
 * has a second effect worth knowing — the columns array keeps its identity
 * across a drag, so a drag cannot look like a spec change and trigger a config
 * preview per frame.
 *
 * **This module imports no React.** That is deliberate: the reducer is the part
 * worth testing hardest, and the vitest config runs in a node environment with
 * no jsdom, so keeping the logic here makes it directly reachable.
 */
import type { ExprNode } from './types'

const HISTORY_LIMIT = 100

/**
 * One column of the feature set.
 *
 * `NamedExpr` minus its positions -- see the module comment on why placement is
 * not part of the document. `NamedExpr` remains the shape used at the
 * serialisation boundary.
 */
export interface FeatureColumn {
  id: string
  name: string
  expr: ExprNode
}

export interface FeatureSetPresent {
  columns: FeatureColumn[]
  activeId: string
}

export interface FeatureSetState {
  present: FeatureSetPresent
  past: FeatureSetPresent[]
  future: FeatureSetPresent[]
  /**
   * What produced `present`, so a run of like edits coalesces into one entry.
   * Typing three letters into a name is one undo, not three. Cleared by any
   * action that is not a continuation of that run, and by undo.
   */
  tag: string | null
}

export type FeatureSetAction =
  // -- document edits; these push history
  | { type: 'edit'; columnId: string; apply: (current: ExprNode) => ExprNode }
  | { type: 'replaceExpr'; columnId: string; expr: ExprNode }
  | { type: 'rename'; columnId: string; name: string }
  | { type: 'add'; column: FeatureColumn; at?: number }
  | { type: 'remove'; columnId: string }
  | { type: 'reorder'; from: number; to: number }
  // -- presentational; amends the present without touching the stacks
  | { type: 'activate'; columnId: string }
  // -- the document was replaced from outside
  | { type: 'reseed'; columns: FeatureColumn[]; activeId?: string }
  | { type: 'undo' }
  | { type: 'redo' }

export function initialFeatureSet(columns: FeatureColumn[]): FeatureSetState {
  return {
    present: { columns, activeId: columns[0]?.id ?? '' },
    past: [],
    future: [],
    tag: null,
  }
}

const push = (state: FeatureSetState, present: FeatureSetPresent,
              tag: string | null = null): FeatureSetState => ({
  present,
  past: [...state.past, state.present].slice(-HISTORY_LIMIT),
  future: [],
  tag,
})

/** Change the present without recording it. Selection is not an edit. */
const amend = (state: FeatureSetState, present: FeatureSetPresent): FeatureSetState =>
  ({ ...state, present, tag: null })

const replace = (columns: FeatureColumn[], id: string,
                 change: (c: FeatureColumn) => FeatureColumn): FeatureColumn[] =>
  columns.map((c) => (c.id === id ? change(c) : c))

/**
 * The reducer.
 *
 * It never mints an id. `add` takes a fully built column and the caller supplies
 * the id, because React's StrictMode invokes reducers twice in development: an
 * id-minting reducer would burn ids and produce two different states from one
 * dispatch. This is the subtlest correctness rule in the file and there is a
 * test pinning it.
 */
export function featureSetReducer(state: FeatureSetState,
                                  action: FeatureSetAction): FeatureSetState {
  const { columns, activeId } = state.present

  switch (action.type) {
    case 'edit': {
      const target = columns.find((c) => c.id === action.columnId)
      if (!target) return state
      const expr = action.apply(target.expr)
      // An edit that changes nothing is not history.
      if (expr === target.expr) return state
      return push(state, {
        columns: replace(columns, action.columnId, (c) => ({ ...c, expr })),
        activeId,
      })
    }

    case 'replaceExpr': {
      if (!columns.some((c) => c.id === action.columnId)) return state
      return push(state, {
        columns: replace(columns, action.columnId, (c) => ({ ...c, expr: action.expr })),
        activeId,
      })
    }

    case 'rename': {
      const target = columns.find((c) => c.id === action.columnId)
      if (!target || target.name === action.name) return state
      const next = {
        columns: replace(columns, action.columnId, (c) => ({ ...c, name: action.name })),
        activeId,
      }
      // Coalesce a run of renames on one column into a single undo step.
      const tag = `rename:${action.columnId}`
      return state.tag === tag
        ? { ...state, present: next }
        : push(state, next, tag)
    }

    case 'add': {
      const at = action.at ?? columns.length
      const next = [...columns.slice(0, at), action.column, ...columns.slice(at)]
      return push(state, { columns: next, activeId: action.column.id })
    }

    case 'remove': {
      // The strip always has at least one tab; an empty canvas has nothing to
      // draw and no obvious way back.
      if (columns.length <= 1) return state
      const index = columns.findIndex((c) => c.id === action.columnId)
      if (index === -1) return state
      const next = columns.filter((c) => c.id !== action.columnId)
      const nextActive = action.columnId === activeId
        ? (next[index - 1] ?? next[0]).id
        : activeId
      return push(state, { columns: next, activeId: nextActive })
    }

    case 'reorder': {
      const { from, to } = action
      if (from === to || from < 0 || to < 0
          || from >= columns.length || to >= columns.length) return state
      const next = [...columns]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return push(state, { columns: next, activeId })
    }

    case 'activate': {
      if (action.columnId === activeId
          || !columns.some((c) => c.id === action.columnId)) return state
      return amend(state, { columns, activeId: action.columnId })
    }

    case 'reseed':
      // A set pushed in from outside -- a saved strategy loaded, a proposal
      // applied -- is a new document, not an edit. Undoing across that boundary
      // would resurrect columns from a different strategy. Taken verbatim,
      // empty included: quietly keeping the old columns on an empty reseed is
      // how one strategy's features leaked into another. Callers decide what
      // an empty document should hold instead.
      return initialFeatureSet(action.columns)

    case 'undo': {
      if (!state.past.length) return state
      return {
        present: state.past[state.past.length - 1],
        past: state.past.slice(0, -1),
        future: [state.present, ...state.future],
        tag: null,
      }
    }

    case 'redo': {
      if (!state.future.length) return state
      const [next, ...rest] = state.future
      return {
        present: next,
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        future: rest,
        tag: null,
      }
    }
  }
}

export const activeColumn = (state: FeatureSetState): FeatureColumn | undefined =>
  state.present.columns.find((c) => c.id === state.present.activeId)
