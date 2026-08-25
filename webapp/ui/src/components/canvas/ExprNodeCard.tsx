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
 * The one hue here that is not state is `--type-process`, and it is deliberately
 * the *same* hue on every card: the whole factor canvas is the pipeline's
 * **shape** phase, so the header wash, the icon tile and the base rule say "you
 * are inside Features" -- which is identity, the job `StageNodeCard` and
 * `FeatureNodeCard` already spend that token on. It is not a per-card verdict
 * and it is not a category: the six `OpCategory` values still get no hues of
 * their own, because six colours is a legend nobody reads and the icon plus the
 * group badge already tell them apart.
 *
 * Every card prints its own sub-expression in its footer, so a reader never has
 * to trace edges to find out what the card in front of them means.
 *
 * ## The header's padding is a number in another file
 *
 * `lib/factorExpr/layout.ts` sizes every card before React Flow paints --
 * `HEADER_H + rows * ROW_H + FOOTER_H` -- and nothing measures the DOM
 * afterwards, so the `h-[30px]` slot rows below are that file's `ROW_H` written
 * in Tailwind and the header band is its `HEADER_H`. The `h-6` phase tile is
 * affordable only at `py-1`: 24 + 8 + a 1px rule is 33 against a declared 32,
 * marginally closer than the 30.5 it replaces. Anything taller has to be paid
 * for in `layout.ts`, or parents stop centring on their children.
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  Database, Divide, Equal, GitBranch, GitCompare, Hash, Sigma, Waves,
} from 'lucide-react'

import { useEditor } from './editorContext'
import { Badge } from '@/components/ui/badge'
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
 * The shape phase, spelt out three times rather than mapped.
 *
 * `StageNodeCard` needs `TONE_WASH`/`TONE_MEDALLION`/`TONE_BASE` as records
 * because it draws four phases; this canvas is one stage of one phase, so the
 * same three roles are three constants. Keeping the roles named is the point --
 * it is what stops the next hand reaching for a fourth use of the hue.
 */
const PHASE_WASH = 'bg-type-process/[0.06]'
const PHASE_TILE = 'bg-type-process/10 text-type-process'
const PHASE_RULE = 'bg-type-process/70'

/**
 * What the window box is doing when it is not the obvious thing.
 *
 * The same integer means three different things (qlib/data/ops.py:747-752), and
 * two of them are surprising: 0 expands over all history and a fraction is an
 * EWM alpha, not a day count. A negative window reads ahead, which is lookahead
 * anywhere but a label. A plain day count needs no chip -- the number already
 * says it.
 */
function windowMode(value: number | null): string | null {
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
        'aion-expr-card relative rounded-xl border bg-card shadow-card transition',
        'border-border/50 hover:shadow-card-hover',
        incomplete && 'border-clay/50',
        // The output card keeps its glow through a hover, or the one card that
        // is different would stop being different exactly when it is pointed at.
        isRoot && !incomplete && 'border-primary/40 shadow-glow hover:shadow-glow',
      )}
    >
      {/* `rounded-t-xl` because the card cannot be `overflow-hidden`: the empty
          slot handles hang off its left edge and are content, not chrome. */}
      <div
        className={cn(
          'flex items-center gap-2 rounded-t-xl border-b border-border/40 px-2.5 py-1',
          PHASE_WASH,
        )}
      >
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
            PHASE_TILE,
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        {node.kind === 'const' ? (
          // A constant's value is its whole content, so it is edited where it is
          // read rather than through a row of its own.
          <input
            type="number"
            className="nodrag tnum min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 font-mono text-xs font-medium transition-colors duration-200 hover:border-border/50 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
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
        {/* Mint is state -- this is where the expression comes out -- so it is
            the one badge here that is not `muted`. */}
        {isRoot && <Badge variant="primary" className="shrink-0">out</Badge>}
        <Badge className="shrink-0">{data.category}</Badge>
      </div>

      {slots.length > 0 && (
        <div className="py-1">
          {slots.map((slot) => {
            const label = slot.label ?? slot.name
            if (slot.kind === 'series') {
              const child = node.kind === 'call' ? node.args[slot.name] : null
              return (
                <div key={slot.name} className="relative flex h-[30px] items-center px-2.5">
                  {/* Two different things wearing the same element. A filled
                      slot is a *port*, and nothing here is connectable, so it
                      shrinks to the pipeline's inert dot. An empty one is
                      content -- the clay ring is the card telling you what is
                      missing -- so it keeps the full 9px. */}
                  <Handle
                    id={slot.name}
                    type="target"
                    position={Position.Left}
                    className={child ? 'aion-expr-handle' : 'aion-handle-empty'}
                  />
                  <span className="font-mono text-micro uppercase tracking-wider text-muted-foreground/70">
                    {label}
                  </span>
                  {!child && (
                    <span className="ml-auto rounded border border-dashed border-clay/40 px-1.5 py-0.5 font-mono text-micro text-clay">
                      empty
                    </span>
                  )}
                </div>
              )
            }
            const value = node.kind === 'call' ? node.params[slot.name] ?? null : null
            return (
              <div key={slot.name} className="flex h-[30px] items-center gap-2 px-2.5">
                <span className="font-mono text-micro uppercase tracking-wider text-muted-foreground/70">
                  {label}
                </span>
                <span className="ml-auto flex items-center gap-1.5">
                  {slot.kind === 'window' && windowMode(value) && (
                    <Badge className="shrink-0">{windowMode(value)}</Badge>
                  )}
                  <input
                    type="number"
                    // React Flow would otherwise read a drag on the input as a
                    // drag on the card and the caret would never land.
                    className={cn(
                      'nodrag tnum w-16 rounded-md border border-border/50 bg-surface-2 px-2 py-0.5',
                      'text-right font-mono text-label transition-colors duration-200',
                      'focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20',
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
        <div className="truncate border-t border-border/50 px-2.5 py-1 font-mono text-micro text-muted-foreground/70">
          {text}
        </div>
      )}

      {/* The shape phase, on the bottom edge -- the same base rule the Features
          stage card wears on the pipeline, so a card here reads as belonging to
          the card you came in through. Absolutely positioned, so it costs
          `layout.ts` nothing; `rounded-b-xl` in place of the clipping the empty
          handles forbid. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-0 h-[2px] rounded-b-xl',
          PHASE_RULE,
        )}
      />

      <Handle id="out" type="source" position={Position.Right} className="aion-expr-handle" />
    </div>
  )
})
