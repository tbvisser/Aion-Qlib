/**
 * The feature set's column strip.
 *
 * Full width, above the three panes, because it governs the right rail as well
 * as the canvas -- it answers "which feature am I editing", which is not a
 * canvas question.
 *
 * A dot on a tab carries the state of a column you are *not* looking at, which
 * is the whole reason it exists: a hole in column three or a name that would
 * shadow one of Alpha158's own is invisible otherwise until Run refuses.
 */
import { Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Segmented } from '@/components/ui/segmented'
import type { FeatureIssue, FeatureMode } from '@/lib/factorExpr/featureSet'
import type { FeatureColumn } from '@/lib/factorExpr/featureSetReducer'
import { cn } from '@/lib/utils'

interface Props {
  columns: FeatureColumn[]
  activeId: string
  issues: FeatureIssue[]
  mode: FeatureMode
  handler: string
  baseCount: number
  onActivate: (id: string) => void
  onRename: (id: string, name: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
  onModeChange: (mode: FeatureMode) => void
}

export function FeatureTabs({
  columns, activeId, issues, mode, handler, baseCount,
  onActivate, onRename, onAdd, onRemove, onModeChange,
}: Props) {
  const [editing, setEditing] = useState<string | null>(null)

  const worst = (id: string) => {
    const mine = issues.filter((i) => i.columnId === id)
    if (mine.some((i) => i.level === 'error')) return mine.find((i) => i.level === 'error')!
    return mine[0]
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-2 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {columns.map((column) => {
          const issue = worst(column.id)
          const active = column.id === activeId
          return (
            <div
              key={column.id}
              data-testid={`feature-tab-${column.name}`}
              onClick={() => onActivate(column.id)}
              onDoubleClick={() => setEditing(column.id)}
              className={cn(
                'group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors',
                active ? 'bg-foreground/[0.07] text-foreground'
                       : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {editing === column.id ? (
                <NameInput
                  value={column.name}
                  onCommit={(name) => { onRename(column.id, name); setEditing(null) }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <span className="font-mono text-[11px]">{column.name}</span>
              )}

              {issue && (
                <span
                  title={issue.message}
                  data-testid={`feature-dot-${column.name}`}
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full',
                                issue.level === 'error' ? 'bg-destructive' : 'bg-clay')}
                />
              )}

              {columns.length > 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(column.id) }}
                  title={`Remove ${column.name}`}
                  className="opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )
        })}

        <button
          onClick={onAdd}
          data-testid="feature-add"
          title="Add a column"
          className="shrink-0 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {columns.length} {columns.length === 1 ? 'feature' : 'features'}
        </span>
        {/* The app's own switch rather than a copy of its classes. What the copy
            was missing is not visual: radiogroup semantics and roving arrow
            keys, which is the whole reason `Segmented` exists. */}
        <Segmented<FeatureMode>
          size="sm"
          value={mode}
          onChange={onModeChange}
          options={[
            {
              value: 'extend',
              label: 'Extend',
              testId: 'feature-mode-extend',
              title: `Add these columns to ${handler}'s own ${baseCount}`,
            },
            {
              value: 'replace',
              label: 'Replace',
              testId: 'feature-mode-replace',
              title: `Train on these columns alone — ${handler} then only decides the `
                + 'processors and the label',
            },
          ]}
        />
        {/* Same treatment as the count on the other side of the switch: two mono
            micro-labels in one bar reading differently is just a seam. */}
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {mode === 'extend' ? `+ ${handler} (${baseCount})` : `${handler} label only`}
        </span>
      </div>
    </div>
  )
}

function NameInput({ value, onCommit, onCancel }: {
  value: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])

  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(draft)
        if (e.key === 'Escape') onCancel()
      }}
      size={Math.max(draft.length, 4)}
      className="rounded border border-border bg-transparent px-1 font-mono text-[11px] outline-none"
    />
  )
}
