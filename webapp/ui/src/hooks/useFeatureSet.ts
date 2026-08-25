/**
 * Canvas state for a whole feature set.
 *
 * Replaces `useExpression`, which held exactly one anonymous tree. One hook over
 * N columns rather than N composed hooks, for a reason that is not stylistic:
 * hooks cannot be created in a loop, so each column would need its own mounted
 * component to own one — and every set-level operation (delete, reorder, name
 * uniqueness, undo across a delete) would have no owner at all.
 *
 * The document lives in `featureSetReducer`, which imports no React and is
 * tested directly. What is left here is the part that genuinely needs React:
 * the two pieces of canvas state deliberately kept *out* of the document, and a
 * facade.
 *
 * **The facade is what keeps this change small.** It exposes exactly the member
 * names `useExpression` did, bound to the active column, so `ExprNodeCard`,
 * `NodeInspector` and `editorContext` need no changes whatsoever — they still
 * receive "an editor for the expression on screen", which is all they ever
 * cared about.
 */
import { useCallback, useMemo, useReducer, useState } from 'react'

import { resolvePositions } from '@/lib/factorExpr/layout'
import { serialize } from '@/lib/factorExpr/serialize'
import {
  activeColumn, featureSetReducer, initialFeatureSet,
  type FeatureColumn,
} from '@/lib/factorExpr/featureSetReducer'
import { toDraft, uniqueName, validateFeatureSet, type FeatureMode }
  from '@/lib/factorExpr/featureSet'
import {
  insertBlock, removeNode, replaceOp, setConst, setField, setParam, setSlot,
} from '@/lib/factorExpr/tree'
import {
  nextId, type ExprNode, type OperatorRegistry, type OperatorSpec, type XY,
} from '@/lib/factorExpr/types'

interface Options {
  registry: OperatorRegistry
  mode: FeatureMode
  /** Columns the chosen handler already computes; only checked when extending. */
  base: ReadonlySet<string>
  handler?: string
}

export function useFeatureSet(initial: () => FeatureColumn[],
                              { registry, mode, base, handler }: Options) {
  const [state, dispatch] = useReducer(
    featureSetReducer, undefined, () => initialFeatureSet(initial()))

  // Held beside the document, keyed by column, and never undoable. Moving a card
  // is not an edit to the expression -- if it were on the undo stack, dragging a
  // node would bury the change you actually wanted back. Keeping positions out
  // also means a drag does not change the identity of `columns`, so it cannot
  // look like a spec change and fire a config preview per frame.
  const [positions, setPositions] = useState<Record<string, Record<string, XY>>>({})
  const [selection, setSelection] = useState<Record<string, string | null>>({})

  const { columns, activeId } = state.present
  const active = activeColumn(state)
  const expr = active?.expr ?? null

  const edit = useCallback(
    (apply: (current: ExprNode) => ExprNode) =>
      dispatch({ type: 'edit', columnId: activeId, apply }),
    [activeId])

  const selectedId = selection[activeId] ?? null
  const setSelectedId = useCallback((id: string | null) => {
    setSelection((prev) => ({ ...prev, [activeId]: id }))
  }, [activeId])

  /** The editor for the column on screen, in exactly the old shape. */
  const editor = useMemo(() => ({
    setParam: (nodeId: string, slot: string, value: number | null) =>
      edit((c) => setParam(c, nodeId, slot, value)),
    setConst: (nodeId: string, value: number) =>
      edit((c) => setConst(c, nodeId, value)),
    setField: (nodeId: string, name: string) =>
      edit((c) => setField(c, nodeId, name)),
    detach: (parentId: string, slot: string) =>
      edit((c) => setSlot(c, parentId, slot, null)),
    remove: (nodeId: string) => {
      edit((c) => removeNode(c, nodeId))
      setSelection((prev) => (prev[activeId] === nodeId
        ? { ...prev, [activeId]: null } : prev))
    },
    replaceOp: (nodeId: string, spec: OperatorSpec) =>
      edit((c) => replaceOp(c, nodeId, spec, registry)),
    insert: (node: ExprNode) => {
      edit((c) => insertBlock(c, selectedId, node, registry))
      // Selection follows the new card, or two blocks added in a row both
      // target whatever was selected before the first one.
      setSelection((prev) => ({ ...prev, [activeId]: node.id }))
    },
    /** Replace the active column's tree outright, e.g. opening a catalog entry. */
    replaceAll: (next: ExprNode) => {
      dispatch({ type: 'replaceExpr', columnId: activeId, expr: next })
      setPositions((prev) => ({ ...prev, [activeId]: {} }))
      setSelection((prev) => ({ ...prev, [activeId]: null }))
    },
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
  }), [edit, registry, selectedId, activeId])

  const placed = useMemo(
    () => (expr ? resolvePositions(expr, registry, positions[activeId] ?? {}) : {}),
    [expr, registry, positions, activeId])

  const expression = useMemo(
    () => (expr ? serialize(expr, registry) : ''), [expr, registry])

  const moveNode = useCallback((id: string, position: XY) => {
    setPositions((prev) => ({
      ...prev,
      [activeId]: {
        ...(prev[activeId] ?? {}),
        [id]: { x: Math.round(position.x), y: Math.round(position.y) },
      },
    }))
  }, [activeId])

  /** Drop hand placement so the deterministic layout takes over again. */
  const tidy = useCallback(
    () => setPositions((prev) => ({ ...prev, [activeId]: {} })), [activeId])

  // -- set level ----------------------------------------------------------

  const taken = useMemo(() => columns.map((c) => c.name), [columns])

  const set = useMemo(() => ({
    activate: (columnId: string) => dispatch({ type: 'activate', columnId }),
    rename: (columnId: string, name: string) =>
      dispatch({ type: 'rename', columnId, name }),
    reorder: (from: number, to: number) => dispatch({ type: 'reorder', from, to }),
    // Ids are minted here, never in the reducer: StrictMode invokes reducers
    // twice, and an id-minting reducer would return two different states for
    // one dispatch.
    add: (name?: string, expr?: ExprNode) => dispatch({
      type: 'add',
      column: {
        id: nextId('col'),
        name: uniqueName(taken, name ?? 'F'),
        expr: expr ?? { id: nextId('f'), kind: 'field', name: 'close' },
      },
    }),
    duplicate: (columnId: string) => {
      const source = columns.find((c) => c.id === columnId)
      if (!source) return
      dispatch({
        type: 'add',
        column: { id: nextId('col'), name: uniqueName(taken, source.name), expr: source.expr },
      })
    },
    // Not `remove`: the editor facade already owns that name for deleting a
    // card, and both facades are spread into one return value below. A second
    // `remove` here wins the spread and turns "Remove card" into a no-op that
    // the types cannot catch, because both take a lone string.
    removeColumn: (columnId: string) => {
      dispatch({ type: 'remove', columnId })
      setPositions(({ [columnId]: _drop, ...rest }) => rest)
      setSelection(({ [columnId]: _also, ...rest }) => rest)
    },
    reseed: (next: FeatureColumn[]) => {
      dispatch({ type: 'reseed', columns: next })
      setPositions({})
      setSelection({})
    },
  }), [columns, taken])

  const drafts = useMemo(
    // Derived from the columns and NOT from positions, which is what keeps a
    // drag from looking like a document change to whoever is listening.
    () => columns.map((c) => toDraft(c, registry)), [columns, registry])

  const issues = useMemo(
    () => validateFeatureSet(columns, { mode, base, handler }),
    [columns, mode, base, handler])

  return {
    // the active column, in the shape the cards already expect
    expr, expression, placed, selectedId, setSelectedId, moveNode, tidy,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    ...editor,
    // the set
    columns, activeId, active, drafts, issues, ...set,
  }
}

export type ExpressionEditor = ReturnType<typeof useFeatureSet>
