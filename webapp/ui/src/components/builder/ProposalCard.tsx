/**
 * A proposed strategy, and the two buttons that decide its fate.
 *
 * The assistant cannot apply anything — it has no tool that saves or runs — so
 * this card is the only path from a proposal to the form. It shows what would
 * change against what is on screen, because "here is a complete strategy" is
 * unreadable when nineteen fields are listed and two of them moved.
 *
 * Three lists, deliberately distinct:
 *   changed    fields that differ from the current form
 *   assumed    decisions nobody made — the server filled them from defaults
 *   inherited  carried over from the strategy already on screen
 *
 * `assumed` and `inherited` must never be merged. One means "we guessed", the
 * other means "you already decided this", and collapsing them would make the
 * honest list dishonest.
 */
import { Check, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { Proposal } from '@/lib/chat'
import type { StrategySpec } from '@/lib/api'
import { changedKeys, showValue as show } from '@/lib/specDiff'
import { cn } from '@/lib/utils'

interface Props {
  proposal: Proposal
  current: StrategySpec
  applied: boolean
  /**
   * The primary button's label.
   *
   * The front door says "Use this strategy", because from there applying is the
   * whole point and what follows is the canvas. The dock keeps "Apply", because
   * there it is one edit among several to a strategy already on screen.
   */
  primaryLabel?: string
  onApply: () => void
  onDismiss: () => void
}

export function ProposalCard({
  proposal, current, applied, primaryLabel, onApply, onDismiss,
}: Props) {
  const spec = proposal.spec
  const changed = changedKeys(spec, current as unknown as Record<string, unknown>)

  return (
    <div
      data-testid="proposal-card"
      className={cn('overflow-hidden rounded-lg border bg-card',
                    applied ? 'border-primary/40' : 'border-border/50')}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          Proposed strategy
        </span>
        {proposal.source.startsWith('template:') && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
            {proposal.source.replace('template:', '')}
          </span>
        )}
        <span className="ml-auto font-mono text-xs">{show(spec.name)}</span>
      </div>

      <div className="space-y-3 p-3">
        <Rows
          label={changed.length ? `${changed.length} change${changed.length === 1 ? '' : 's'}`
            : 'Identical to what you have'}
          rows={changed.map((k) => ({
            key: k,
            left: show((current as never)[k]),
            right: show(spec[k]),
          }))}
        />

        {proposal.assumed.length > 0 && (
          <Notes
            label={`Assumed — nobody stated ${proposal.assumed.length === 1 ? 'this' : 'these'}`}
            rows={proposal.assumed.map((a) => ({
              key: a.path, value: show(a.value), note: a.why,
            }))}
          />
        )}

        {proposal.inherited.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              {proposal.inherited.length} kept from your current strategy
            </summary>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {proposal.inherited.map((i) => (
                <span key={i.path}
                      className="rounded border border-border/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {i.path}={show(i.value)}
                </span>
              ))}
            </div>
          </details>
        )}

        {proposal.warnings.map((w) => (
          <p key={w} className="text-[11px] leading-relaxed text-clay">{w}</p>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-border/50 px-3 py-2">
        {applied ? (
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-primary">
            <Check className="h-3.5 w-3.5" />
            On the canvas
          </span>
        ) : (
          <>
            <Button size="sm" onClick={onApply} data-testid="proposal-apply">
              <Check className="h-4 w-4" />
              {primaryLabel ?? 'Apply'}
            </Button>
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              <X className="h-4 w-4" />
              Dismiss
            </Button>
            {/* The old copy — "Nothing runs until you press Run backtest" —
                named a header button the front door's scrim was covering at
                that exact moment. Say where you are about to end up instead. */}
            <span className="ml-auto text-[10px] text-muted-foreground">
              You'll see the cards next
            </span>
          </>
        )}
      </div>
    </div>
  )
}

function Rows({ label, rows }: {
  label: string
  rows: { key: string; left: string; right: string }[]
}) {
  return (
    <div>
      <div className="pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-baseline gap-2 py-0.5 font-mono text-[11px]">
          <span className="w-28 shrink-0 truncate text-muted-foreground">{r.key}</span>
          <span className="truncate text-muted-foreground/60 line-through">{r.left}</span>
          <span className="truncate text-primary">{r.right}</span>
        </div>
      ))}
    </div>
  )
}

function Notes({ label, rows }: {
  label: string
  rows: { key: string; value: string; note: string }[]
}) {
  return (
    <div>
      <div className="pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      {rows.map((r) => (
        <div key={r.key} className="py-0.5">
          <span className="font-mono text-[11px]">{r.key}={r.value}</span>
          <span className="ml-2 text-[11px] text-muted-foreground">{r.note}</span>
        </div>
      ))}
    </div>
  )
}
