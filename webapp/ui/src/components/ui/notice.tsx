/**
 * A bordered card carrying a sentence the reader did not ask for.
 *
 * This markup was written twice, identically — once in the Strategy Builder's
 * `Alerts` and once for the Indicators page's dead-column banner — and the
 * builder's coverage and measurement work adds two more sites. It is lifted
 * verbatim from those two so nothing shifts visually.
 *
 * Three tones, and the distinction is the whole point:
 *
 *   destructive  something failed. A request threw, a save was refused.
 *   clay         a statistical or data verdict. Nothing is broken; the number
 *                or the store is telling you something you will not like.
 *   muted        a fact. Unfinished columns, a proxy column, a count.
 *
 * `clay` is not `destructive` with a different hue — see `badge.tsx`, which
 * makes the same split and deliberately declines to offer `destructive` at all.
 * A backtest that lost money is a clay verdict; a backtest that crashed is
 * destructive. Collapsing the two trains people to ignore both.
 */
import { AlertTriangle } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export type NoticeTone = 'clay' | 'destructive' | 'muted'

const BORDER: Record<NoticeTone, string> = {
  clay: 'border-clay/50',
  destructive: 'border-destructive/40',
  muted: 'border-border/50',
}

const TEXT: Record<NoticeTone, string> = {
  clay: 'text-muted-foreground',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
}

export function Notice({
  tone = 'clay', icon = tone === 'clay', className, children,
}: {
  tone?: NoticeTone
  /** Defaults on for `clay`, which is the tone that earns the glyph. */
  icon?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={cn(BORDER[tone], className)}>
      <CardContent className={cn('p-4 text-sm', icon ? 'flex gap-3' : undefined, TEXT[tone])}>
        {icon && <AlertTriangle className={cn('h-4 w-4 shrink-0', tone === 'destructive' ? 'text-destructive' : 'text-clay')} />}
        {icon ? <div className="min-w-0 space-y-1">{children}</div> : children}
      </CardContent>
    </Card>
  )
}
