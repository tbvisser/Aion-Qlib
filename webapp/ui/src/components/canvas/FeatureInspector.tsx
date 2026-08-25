/**
 * The right rail when no card is selected: the column itself.
 *
 * It replaces what used to be a "nothing selected" placeholder, and it is where
 * a name gets fixed — which matters because the name is the field most likely to
 * be wrong in a way that cannot be seen. `MA5` looks perfectly reasonable; it
 * would silently replace one of Alpha158's own columns.
 *
 * `Panel`, not `Section`. This rail stacks it directly on top of `MeasurePanel`,
 * which is a `Panel`, and `Section` is a `Card`: a 24px-padded header with a
 * `text-sm` title sitting on a 1px bar with a 10px mono one. Two chromes for one
 * rail read as two apps, and the tighter of the two is also the one that leaves
 * the measurement chart room.
 */
import { Copy, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useConfirmClick } from '@/hooks/useConfirmClick'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Panel } from '@/components/ui/panel'
import { MeasurePanel, type MeasureContext } from './MeasurePanel'
import type { ExpressionCheck } from '@/hooks/useExpressionCheck'
import type { FeatureIssue } from '@/lib/factorExpr/featureSet'
import type { FeatureColumn } from '@/lib/factorExpr/featureSetReducer'
import { cn } from '@/lib/utils'

interface Props {
  column: FeatureColumn
  expression: string
  issues: FeatureIssue[]
  canRemove: boolean
  onRename: (name: string) => void
  onDuplicate: () => void
  onRemove: () => void
  /** Universe, window and stores — everything measuring this column needs. */
  measure?: MeasureContext
  /**
   * The server's verdict, run once by the canvas.
   *
   * Passed in rather than fetched here because the canvas already merges its
   * defects into `issues` — the tab dot and the blocker list read the same
   * list, and two calls would let the two views disagree.
   */
  check?: ExpressionCheck
}

export function FeatureInspector({
  column, expression, issues, canRemove, onRename, onDuplicate, onRemove, measure, check,
}: Props) {
  // Server defects already arrive here: the canvas folded them into `issues`
  // with this column's id, so they render beside the name problems rather than
  // in a second place with a second voice.
  const mine = issues.filter((i) => i.columnId === column.id)

  // The tab's contract — Enter or blur commits, Escape cancels — for the same
  // field one click away. This input used to commit on every keystroke with no
  // way out, so the two surfaces disagreed about how renaming works.
  const [nameDraft, setNameDraft] = useState(column.name)
  useEffect(() => { setNameDraft(column.name) }, [column.id, column.name])
  const commitName = () => {
    if (nameDraft !== column.name) onRename(nameDraft)
  }

  const del = useConfirmClick()

  return (
    <div className="space-y-4">
      <Panel title="Feature column">
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="font-mono text-micro uppercase tracking-wider text-muted-foreground/70">
              Name
            </span>
            <Input
              value={nameDraft}
              data-testid="feature-name"
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName()
                if (e.key === 'Escape') setNameDraft(column.name)
              }}
              className={cn('h-8 font-mono text-xs',
                            mine.some((i) => i.level === 'error') && 'border-destructive/60')}
            />
          </label>

          {/* Code alone collides: every server defect arrives as
              `server-defect`, and a duplicate key silently drops the second
              message. */}
          {mine.map((issue) => (
            <p key={`${issue.code}:${issue.message}`}
               className={cn('text-label leading-relaxed',
                             issue.level === 'error' ? 'text-destructive' : 'text-clay')}>
              {issue.message}
            </p>
          ))}

          {/* Same radius as the `Renders as` block in `NodeInspector`: it is the
              same expression, printed in the same rail, one selection apart. */}
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-2 font-mono text-micro leading-relaxed">
            {expression || '—'}
          </pre>

          {/* The positive facts the same call returns, and nothing else in the
              app shows: how much history the column needs before it means
              anything, and whether it reads any future at all. */}
          {check?.result?.ok && (
            <p className="font-mono text-micro leading-relaxed text-muted-foreground/70">
              checked against {measure?.store ?? 'this store'}
              {check.result.longest_back_rolling != null
                && ` · needs ${check.result.longest_back_rolling} days of history`}
              {check.result.longest_back_rolling === null && ' · needs unbounded history'}
            </p>
          )}
          {check?.checking && (
            <p className="font-mono text-micro text-muted-foreground/70">checking…</p>
          )}
        </div>
      </Panel>

      {measure && <MeasurePanel expression={expression} context={measure} />}

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onDuplicate}>
          <Copy className="h-4 w-4" />
          Duplicate
        </Button>
        {/* Two-click, like every other delete outside a dialog: a whole
            column is authored work and went on the first click before. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => del.fire(onRemove)}
          onMouseLeave={del.disarm}
          disabled={!canRemove}
          className={cn(del.confirming && 'text-clay')}
          title={!canRemove ? 'A feature set needs at least one column'
                            : del.confirming ? 'Click again to delete'
                                             : 'Remove this column'}
        >
          <Trash2 className="h-4 w-4" />
          {del.confirming ? 'sure?' : 'Delete'}
        </Button>
      </div>

      <p className="text-label leading-relaxed text-muted-foreground">
        Pick a card to change it, or add a block from the left. A block lands in the
        selected card’s empty slot, or wraps it when there is none.
      </p>
    </div>
  )
}
