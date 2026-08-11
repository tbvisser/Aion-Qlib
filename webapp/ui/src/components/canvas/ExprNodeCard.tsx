/**
 * One card on the canvas: a leaf field, a number, or an operator with its slots.
 *
 * Colour carries state, never category. The palette has one accent and
 * `index.css` forbids inventing tokens, so operators are told apart by icon and
 * group chip, and the colours mean exactly one thing each:
 *
 *   mint         this is the output of the expression
 *   clay         you have not finished -- an empty slot, an unset window
 *   destructive  the engine refused it  (arrives with validation, in M5)
 *
 * Every card prints its own sub-expression in its footer, so a reader never has
 * to trace edges to find out what the card in front of them means.
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  Database, Divide, Equal, GitBranch, GitCompare, Hash, Sigma, Waves,
} from 'lucide-react'

import { useEditor } from './editorContext'
import { HOLE } from '@/lib/factorExpr/serialize'
import type { ExprCardData, ExprFlowNode } from '@/lib/factorExpr/toFlow'
import type { OpCategory } from '@/lib/factorExpr/types'
import { cn } from '@/lib/utils'

const ICONS: Record<OpCategory | 'field' | 'const', typeof Database> = {
  field: Database,
  const: Hash,
  arithmetic: Divide,
  compare: Equal,
  rolling: Sigma,
  pair: GitCompare,
  elementwise: Waves,
  logic: GitBranch,
}

/**
 * What the window box is doing when it is not the obvious thing.
 *
 * The same integer means three different things (qlib/data/ops.py:747-752), and
 * two of them are surprising: 0 expands over all history and a fraction is an
 * EWM alpha, not a day count. A negative window reads ahead, which is lookahead
 * anywhere but a label. A plain day count needs no chip -- the number already
 * says it.
 */
export function windowMode(value: number | null): string | null {
  if (value === null) return null
  if (value === 0) return 'expanding'
  if (value > 0 && value < 1) return `ewm α=${value}`
  if (value < 0) return 'reads ahead'
  return null
}

function title(data: ExprCardData): string {
  const { node } = data
  if (node.kind === 'field') return `$${node.name}`
  if (node.kind === 'const') return String(node.value)
  return data.spec?.name ?? node.op
}

export const ExprNodeCard = memo(function ExprNodeCard({ data }: NodeProps<ExprFlowNode>) {
  const editor = useEditor()
  const { node, spec, text, isRoot, incomplete } = data
  const category: OpCategory | 'field' | 'const' =
    node.kind === 'call' ? (spec?.category ?? 'arithmetic') : node.kind
  const Icon = ICONS[category]
  const slots = node.kind === 'call' ? (spec?.slots ?? []) : []

  return (
    <div
      style={{ width: data.width }}
      className={cn(
        'aion-expr-card rounded-lg border bg-card shadow-card transition-colors',
        'border-border/50',
        incomplete && 'border-clay/50',
        isRoot && !incomplete && 'border-primary/40 shadow-glow',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-2.5 py-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {node.kind === 'const' ? (
          // A constant's value is its whole content, so it is edited where it is
          // read rather than through a row of its own.
          <input
            type="number"
            className="nodrag tnum min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-xs font-medium outline-none hover:border-border/50 focus:border-primary/50"
            value={node.value}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (e.target.value !== '' && !Number.isNaN(next)) {
                editor.setConst(node.id, next)
              }
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
            {title(data)}
          </span>
        )}
        {isRoot && (
          <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[9px] uppercase text-primary">
            out
          </span>
        )}
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
          {data.category}
        </span>
      </div>

      {slots.length > 0 && (
        <div className="py-1">
          {slots.map((slot) => {
            const label = slot.label ?? slot.name
            if (slot.kind === 'series') {
              const child = node.kind === 'call' ? node.args[slot.name] : null
              return (
                <div key={slot.name} className="relative flex h-[30px] items-center px-2.5">
                  <Handle
                    id={slot.name}
                    type="target"
                    position={Position.Left}
                    className={cn(!child && 'aion-handle-empty')}
                  />
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    {label}
                  </span>
                  {!child && (
                    <span className="ml-auto rounded border border-dashed border-clay/40 px-1.5 py-0.5 font-mono text-[10px] text-clay">
                      empty
                    </span>
                  )}
                </div>
              )
            }
            const value = node.kind === 'call' ? node.params[slot.name] ?? null : null
            return (
              <div key={slot.name} className="flex h-[30px] items-center gap-2 px-2.5">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  {label}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  {slot.kind === 'window' && windowMode(value) && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                      {windowMode(value)}
                    </span>
                  )}
                  <input
                    type="number"
                    // React Flow would otherwise read a drag on the input as a
                    // drag on the card and the caret would never land.
                    className={cn(
                      'nodrag tnum w-16 rounded border border-border/50 bg-surface-2 px-2 py-0.5',
                      'text-right font-mono text-[11px] outline-none focus:border-primary/50',
                      value === null && 'border-dashed border-clay/40',
                    )}
                    placeholder={HOLE}
                    value={value ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value
                      const next = raw === '' ? null : Number(raw)
                      if (next === null || !Number.isNaN(next)) {
                        editor.setParam(node.id, slot.name, next)
                      }
                    }}
                  />
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* A leaf's header already is its expression; repeating it says nothing. */}
      {text !== title(data) && (
        <div className="truncate border-t border-border/50 px-2.5 py-1 font-mono text-[10px] text-muted-foreground/70">
          {text}
        </div>
      )}

      <Handle id="out" type="source" position={Position.Right} />
    </div>
  )
})
