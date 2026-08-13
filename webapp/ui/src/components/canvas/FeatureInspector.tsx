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

  return (
    <div className="space-y-4">
      <Panel title="Feature column">
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              Name
            </span>
            <Input
              value={column.name}
              data-testid="feature-name"
              onChange={(e) => onRename(e.target.value)}
              className={cn('h-8 font-mono text-xs',
                            mine.some((i) => i.level === 'error') && 'border-destructive/60')}
            />
          </label>

          {mine.map((issue) => (
            <p key={issue.code}
               className={cn('text-[11px] leading-relaxed',
                             issue.level === 'error' ? 'text-destructive' : 'text-clay')}>
              {issue.message}
            </p>
          ))}

          {/* Same radius as the `Renders as` block in `NodeInspector`: it is the
              same expression, printed in the same rail, one selection apart. */}
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-2 font-mono text-[10px] leading-relaxed">
            {expression || '—'}
          </pre>

          {/* The positive facts the same call returns, and nothing else in the
              app shows: how much history the column needs before it means
              anything, and whether it reads any future at all. */}
          {check?.result?.ok && (
            <p className="font-mono text-[10px] leading-relaxed text-muted-foreground/70">
              checked against {measure?.store ?? 'this store'}
              {check.result.longest_back_rolling != null
                && ` · needs ${check.result.longest_back_rolling} days of history`}
              {check.result.longest_back_rolling === null && ' · needs unbounded history'}
            </p>
          )}
          {check?.checking && (
            <p className="font-mono text-[10px] text-muted-foreground/70">checking…</p>
          )}
        </div>
      </Panel>

      {measure && <MeasurePanel expression={expression} context={measure} />}

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onDuplicate}>
          <Copy className="h-4 w-4" />
          Duplicate
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={!canRemove}
          title={canRemove ? 'Remove this column'
                           : 'A feature set needs at least one column'}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Pick a card to change it, or add a block from the left. A block lands in the
        selected card’s empty slot, or wraps it when there is none.
      </p>
    </div>
  )
}
