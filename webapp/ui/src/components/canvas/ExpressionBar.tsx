/**
 * The bar pinned to the bottom of the canvas, showing what the cards add up to.
 *
 * The canvas is only trustworthy if the string it produces is visible while you
 * build it -- otherwise the user is composing blind and has to run something to
 * find out what they made. This is the single most important readout on the
 * page, which is why it is pinned rather than tucked in a panel.
 */
import { Check, Copy, LayoutGrid, Redo2, Undo2 } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { hasHole } from '@/lib/factorExpr/serialize'
import { cn } from '@/lib/utils'

interface Props {
  /** Which column this is. The bar is otherwise ambiguous with several open. */
  name?: string
  expression: string
  onTidy: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  /**
   * One word about the server's verdict.
   *
   * A word, not a panel: this bar is 44px with five controls, and the full
   * sentence belongs in the inspector. But this is the line people watch while
   * drawing, so it is where "you just wrote a lookahead" should first appear.
   */
  status?: string | null
}

export function ExpressionBar({
  name, expression, onTidy, onUndo, onRedo, canUndo, canRedo, status,
}: Props) {
  const [copied, setCopied] = useState(false)
  const incomplete = hasHole(expression)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(expression)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard is a convenience; a refusal must not break the canvas */
    }
  }

  return (
    <div className="glass absolute inset-x-0 bottom-0 z-10 flex items-center gap-3 border-t border-border/50 px-4 py-2.5">
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {name ?? 'Expression'}
      </span>
      <code
        data-testid="expr-bar"
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-xs',
          incomplete && 'text-clay',
        )}
      >
        {expression}
      </code>
      {/* `clay` for both verdicts and `muted` while the server is still
          thinking: an unfinished column and a refused one are the same kind of
          news -- something about this expression is not right yet -- and
          neither is an error, which is why `Badge` declines to offer one. */}
      {incomplete ? (
        <Badge variant="clay" className="shrink-0">unfinished</Badge>
      ) : status ? (
        <Badge
          data-testid="expr-status"
          variant={status === 'checking' ? 'muted' : 'clay'}
          className="shrink-0"
        >
          {status}
        </Badge>
      ) : null}
      <Button variant="ghost" size="sm" onClick={onUndo} disabled={!canUndo}
              title="Undo — across the whole feature set" className="shrink-0">
        <Undo2 className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={onRedo} disabled={!canRedo}
              title="Redo — across the whole feature set" className="shrink-0">
        <Redo2 className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="sm" onClick={onTidy} className="shrink-0">
        <LayoutGrid className="h-4 w-4" />
        Tidy
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void copy()}
        disabled={incomplete}
        className="shrink-0"
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
