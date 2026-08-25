/**
 * The canvas: a feature set drawn as columns, each one an expression tree.
 *
 * The tree is the source of truth and the React Flow graph is derived from it on
 * every render. Only positions are written back. That is the whole architecture,
 * and it is what makes an unserialisable canvas state impossible -- there is no
 * graph to get out of step with, because the graph is a projection.
 *
 * What is drawn is the *active* column. Switching tabs changes which tree the
 * projection is taken from; it does not remount anything, because the node set
 * is derived and `RefitOnStructureChange` already handles a wholesale change of
 * node ids.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, BackgroundVariant, Controls, ReactFlow, useReactFlow,
  type NodeChange, type NodeTypes,
} from '@xyflow/react'

import { BuilderRail } from './BuilderRail'
import { EditorContext } from './editorContext'
import { ExpressionBar } from './ExpressionBar'
import { ExprNodeCard } from './ExprNodeCard'
import { FeatureInspector } from './FeatureInspector'
import type { MeasureContext } from './MeasurePanel'
import { FeatureTabs } from './FeatureTabs'
import { NodeInspector } from './NodeInspector'
import { Notice } from '@/components/ui/notice'
import { useExpressionCheck } from '@/hooks/useExpressionCheck'
import { useFactorLibrary } from '@/hooks/useFactorLibrary'
import { useFeatureSet } from '@/hooks/useFeatureSet'
import { useOperators } from '@/hooks/useOperators'
import { type FeatureMode, type SpecFeature, type StoredStrategy,
         type StrategySpec } from '@/lib/api'
import { baseColumns } from '@/lib/factorExpr/baseColumns'
import { fromSpecFeatures, type FeatureDraft, type FeatureIssue }
  from '@/lib/factorExpr/featureSet'
import type { FeatureColumn } from '@/lib/factorExpr/featureSetReducer'
import { parse } from '@/lib/factorExpr/parse'
import { FALLBACK_REGISTRY } from '@/lib/factorExpr/registry'
import { EXPR_NODE_TYPE, toFlowEdges, toFlowNodes } from '@/lib/factorExpr/toFlow'
import { findNode } from '@/lib/factorExpr/tree'
import { call, constant, field, nextId, type ExprNode } from '@/lib/factorExpr/types'

import '@xyflow/react/dist/base.css'
import '@/styles/reactflow.css'

/** Must be referentially stable or React Flow remounts every node each render. */
const nodeTypes: NodeTypes = { [EXPR_NODE_TYPE]: ExprNodeCard }

/**
 * `Ref($close,20)/$close - 1` -- the catalog's ROC20.
 *
 * Built from the built-in registry rather than the served one because it runs
 * once, before any fetch can land. That is safe precisely because the two agree
 * on slot names: a backend test asserts the served `Add`/`Ref`/`Div` still use
 * `left`/`right`/`feature` rather than qlib's own `feature_left`, which is what
 * `call()` looks up.
 */
function initialExpression(): ExprNode {
  const ref = call(FALLBACK_REGISTRY.Ref, { feature: field('close') }, { N: 20 })
  const ratio = call(FALLBACK_REGISTRY.Div, { left: ref, right: field('close') })
  return call(FALLBACK_REGISTRY.Sub, { left: ratio, right: constant(1) })
}

export interface FeatureSetSnapshot {
  /** Every column, finished or not. Only the finished ones reach the spec. */
  features: FeatureDraft[]
  /** The column being edited -- what the assistant is looking at. */
  active: string
  /**
   * That column's *name*, for anything outside the canvas that has to say which
   * one is open -- the breadcrumb, so far.
   *
   * Carried rather than recovered from `features` by matching `active`: two
   * columns are allowed to hold the same expression, and a breadcrumb naming
   * the wrong one of them is worse than no breadcrumb.
   */
  activeName?: string
  issues: FeatureIssue[]
  /**
   * Saved columns whose expressions would not parse, so they are not on the
   * canvas. The page appends them back into `spec.features` untouched: the
   * canvas must never silently delete a feature it could not draw, because the
   * user would save over it and lose it for good.
   */
  unparsed: { name: string; expression: string }[]
}

/**
 * Bring the whole expression back into view when it gains or loses a card.
 *
 * Keyed on the set of node ids rather than on the tree, so editing a window or
 * dragging a card never yanks the viewport -- only a change in what exists,
 * which is the one case where the graph can grow past the edge of the screen.
 * A tab switch changes every id at once, so this covers that too.
 */
function RefitOnStructureChange({ signature }: { signature: string }) {
  const { fitView } = useReactFlow()
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    void fitView({ padding: 0.25, maxZoom: 1, duration: 200 })
  }, [signature, fitView])
  return null
}

interface Props {
  /** The saved feature set to open. Read once per `revision`. */
  initialFeatures?: SpecFeature[] | null
  /**
   * Bumped only when the spec is replaced from *outside* -- a saved strategy
   * loaded, an assistant proposal applied. Never on an ordinary edit, or the
   * canvas would be reseeded mid-keystroke.
   */
  revision?: number
  handler?: string
  /**
   * The store the strategy targets, so the palette is judged against it.
   *
   * Absent, both `/factors` and `/indicators` fall back to whichever store the
   * API process mounted — which is how a crypto strategy came to be built
   * against a palette describing the US store.
   */
  store?: string
  /**
   * Universe and test window, so a column can be measured where it matters.
   *
   * Passed as decisions rather than as the whole spec: the canvas's prop
   * surface is a list of things it needs, not a dependency on a spec shape.
   */
  measure?: MeasureContext
  mode?: FeatureMode
  onModeChange?: (mode: FeatureMode) => void
  /** Must be referentially stable: it drives a debounced network call. */
  onChange?: (snapshot: FeatureSetSnapshot) => void
  /** An expression handed over from another page; opens as a new column. */
  openExpression?: string
  openName?: string
  /** The rail's templates half — saved strategies and what to do with them. */
  saved?: StoredStrategy[]
  currentId?: string
  onUseTemplate?: (spec: StrategySpec) => void
  onOpenSaved?: (strategy: StoredStrategy) => void
  onDeleteSaved?: (strategy: StoredStrategy) => void
}

export function FactorCanvas({
  initialFeatures, revision = 0, handler = 'Alpha158', store, measure, mode = 'extend',
  onModeChange, onChange, openExpression, openName,
  saved = [], currentId, onUseTemplate = () => {}, onOpenSaved = () => {},
  onDeleteSaved = () => {},
}: Props = {}) {
  const { registry } = useOperators()
  const { catalog, families, indicators, fields } = useFactorLibrary(store)
  const [parseError, setParseError] = useState<string | null>(null)

  // Store-independent on purpose: the collision set is a set of *names*, and
  // Alpha158 emits the same 158 names whatever store it is pointed at. Only the
  // runnable/dead judgement varies by store, and that lives on the rows.
  const base = useMemo(() => baseColumns(handler, indicators), [handler, indicators])

  // Read once, at mount; later changes arrive through `revision`. A ref rather
  // than a memo because `fromSpecFeatures` mints ids, and StrictMode re-running
  // a memo would mint a second set.
  const seeded = useRef<ReturnType<typeof fromSpecFeatures> | null>(null)
  if (seeded.current === null) {
    seeded.current = fromSpecFeatures(initialFeatures, FALLBACK_REGISTRY,
                                      () => nextId('col'))
  }
  /** Saved columns that would not parse; kept so a save cannot drop them. */
  const [unparsed, setUnparsed] = useState<{ name: string; expression: string }[]>(
    () => seeded.current?.failures ?? [])

  const seed = useCallback((): FeatureColumn[] => {
    const columns = seeded.current?.columns ?? []
    return columns.length
      ? columns
      : [{ id: nextId('col'), name: 'F1', expr: initialExpression() }]
  }, [])

  const editor = useFeatureSet(seed, { registry, mode, base, handler })
  const {
    expr, placed, selectedId, setSelectedId, columns, activeId, active, drafts,
    issues: clientIssues,
  } = editor

  /**
   * The server's read of the active column, merged into the same issue list.
   *
   * Only the active column: the endpoint is cheap, but checking every column on
   * every keystroke is not, and the column being edited is the one whose verdict
   * anybody is waiting on. Merging rather than keeping a parallel list is what
   * lets the tab dot and the blocker count see it — a lookahead used to surface
   * only when Run was refused.
   */
  const check = useExpressionCheck(editor.expression, store)
  const issues = useMemo(() => {
    const serverIssues = !active || !check.result || check.result.ok
      ? []
      : check.result.defects.map((defect): FeatureIssue => ({
          columnId: active.id,
          level: 'error',
          code: 'server-defect',
          message: defect.message,
        }))
    // A warning, not an error: the column is preserved in the spec untouched,
    // so nothing about the run changes — but whoever saved it should hear
    // that it cannot be edited here.
    const unparsedIssues = unparsed.map((f): FeatureIssue => ({
      columnId: null,
      level: 'warning',
      code: 'unparsed',
      message: `“${f.name}” could not be drawn (${f.expression}). It is kept `
        + 'in the strategy unchanged, but cannot be edited on this canvas.',
    }))
    return [...clientIssues, ...serverIssues, ...unparsedIssues]
  }, [clientIssues, check.result, active, unparsed])

  useEffect(() => {
    onChange?.({
      features: drafts, active: editor.expression, activeName: active?.name, issues,
      unparsed,
    })
  }, [drafts, editor.expression, active?.name, issues, unparsed, onChange])

  /**
   * Re-seed when the spec was replaced from outside.
   *
   * Only on a `revision` bump. Diffing `initialFeatures` against the drafts on
   * every render would fight the canvas mid-edit and eventually stomp a tree
   * the user is holding.
   */
  const seededAt = useRef(revision)
  useEffect(() => {
    if (revision === seededAt.current) return
    seededAt.current = revision
    const { columns: next, failures } = fromSpecFeatures(initialFeatures, registry,
                                                         () => nextId('col'))
    // Unconditionally, empty included. Skipping the empty case left the
    // previous strategy's columns on the canvas, and the sync effect then
    // wrote them into the newly opened spec — a strategy with no custom
    // features silently inherited another one's. Empty reseeds to the same
    // starter column a fresh mount gets.
    editor.reseed(next.length
      ? next
      : [{ id: nextId('col'), name: 'F1', expr: initialExpression() }])
    setUnparsed(failures)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  /**
   * A library entry becomes a new column, named after itself.
   *
   * It used to replace the active column, on the reasoning that a catalog entry
   * is a whole tree with nowhere to graft. True, but the wrong conclusion once
   * the library grew past a hundred searchable rows: replacing silently destroys
   * a tree the user is holding, and a misclick in a long list is routine rather
   * than rare. Adding is also what makes the library usable as a library —
   * click five factors, get a five-column feature set.
   *
   * Same verb the Indicators-page handoff already uses, so the two routes into
   * the canvas now behave identically.
   */
  const addFrom = useCallback((source: string, name?: string) => {
    const result = parse(source, registry)
    if (!result.ok) {
      setParseError(`${source} — ${result.error.message}`)
      return
    }
    setParseError(null)
    editor.add(name, result.node)
  }, [editor, registry])

  /**
   * An expression handed over from the Indicators page **adds** a column.
   *
   * Different verb from the palette on purpose: someone arriving from the
   * library is collecting features, and replacing would now destroy a whole
   * column they cannot see coming from another page.
   *
   * Guarded by a ref rather than a cleanup because `add` is not idempotent and
   * StrictMode mounts effects twice.
   */
  const handedOver = useRef<string | null>(null)
  useEffect(() => {
    if (!openExpression || handedOver.current === openExpression) return
    const result = parse(openExpression, registry)
    if (!result.ok) {
      setParseError(`${openExpression} — ${result.error.message}`)
      return
    }
    handedOver.current = openExpression
    setParseError(null)
    editor.add(openName, result.node)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openExpression, openName, registry])

  // `registry` is in the dependencies because it is no longer a constant: the
  // served vocabulary arrives after mount, and a card rendered from the built-in
  // spec has to re-derive when it does.
  const nodes = useMemo(
    () => (expr ? toFlowNodes(expr, registry, placed) : [])
      .map((n) => ({ ...n, selected: n.id === selectedId })),
    [expr, registry, placed, selectedId])

  const edges = useMemo(
    () => (expr ? toFlowEdges(expr, registry) : []), [expr, registry])

  const selectedNode = useMemo(
    () => (expr && selectedId ? findNode(expr, selectedId) : null), [expr, selectedId])

  /**
   * Nodes are derived, so most changes are not ours to apply -- only position
   * and selection are canvas state rather than tree state.
   */
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        editor.moveNode(change.id, change.position)
      } else if (change.type === 'select') {
        setSelectedId(change.selected ? change.id : null)
      }
    }
  }, [editor, setSelectedId])

  return (
    <EditorContext.Provider value={editor}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <FeatureTabs
          columns={columns}
          activeId={activeId}
          issues={issues}
          mode={mode}
          handler={handler}
          baseCount={base.size}
          onActivate={editor.activate}
          onRename={editor.rename}
          onAdd={() => editor.add()}
          onRemove={editor.removeColumn}
          onModeChange={(m) => onModeChange?.(m)}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <BuilderRail
            canInsert
            registry={registry}
            fields={fields}
            catalog={catalog}
            families={families}
            indicators={indicators}
            saved={saved}
            currentId={currentId}
            onInsert={editor.insert}
            onAdd={addFrom}
            onUseTemplate={onUseTemplate}
            onOpenSaved={onOpenSaved}
            onDeleteSaved={onDeleteSaved}
          />

          <div className="relative min-h-0 min-w-0 flex-1" data-testid="factor-canvas">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onPaneClick={() => setSelectedId(null)}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
              minZoom={0.25}
              maxZoom={1.5}
              nodesConnectable={false}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: false }}
            >
              <Background variant={BackgroundVariant.Lines} gap={24} color="hsl(var(--border) / 0.5)" />
              {/* Bottom-left, as on the pipeline canvas: top-right is where the
                  parse banner lands and, on a right-rooted tree, where the
                  output card sits. Lifted clear of the ExpressionBar, which is
                  57px of glass pinned across the bottom of *this* canvas and
                  has no counterpart on the pipeline one (an h-9 button, py-2.5
                  either side of it, and the bar's own top rule). */}
              <Controls showInteractive={false} position="bottom-left" style={{ bottom: 57 }} />
              <RefitOnStructureChange signature={`${activeId}:${nodes.map((n) => n.id).join()}`} />
            </ReactFlow>

            {/* The same `Notice` the builder page uses for a failed request, in
                the same tone: a source string the parser refused is a failure,
                not a verdict about the strategy. It floats over the canvas
                rather than pushing it down, so the tree does not jump when a
                misclick in the library is reported. */}
            {parseError && (
              <div className="absolute inset-x-0 top-0 z-10 p-3">
                <Notice tone="destructive" icon={false}>{parseError}</Notice>
              </div>
            )}

            <ExpressionBar
              status={check.checking ? 'checking'
                : check.result && !check.result.ok
                  ? (check.result.defects[0]?.code.replace(/_/g, ' ') ?? 'refused')
                  : null}
              name={active?.name}
              expression={editor.expression}
              onTidy={editor.tidy}
              onUndo={editor.undo}
              onRedo={editor.redo}
              canUndo={editor.canUndo}
              canRedo={editor.canRedo}
            />
          </div>

          <NodeInspector
            node={selectedNode}
            registry={registry}
            fields={fields}
            editor={editor}
            isRoot={selectedNode?.id === expr?.id}
            empty={active && (
              <FeatureInspector
                column={active}
                expression={editor.expression}
                issues={issues}
                canRemove={columns.length > 1}
                onRename={(name) => editor.rename(active.id, name)}
                onDuplicate={() => editor.duplicate(active.id)}
                onRemove={() => editor.removeColumn(active.id)}
                measure={measure}
                check={check}
              />
            )}
          />
        </div>
      </div>
    </EditorContext.Provider>
  )
}
