import { Ban, CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react'
import type { RunStatus } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * The one place a run status becomes a colour. Mint = succeeded, destructive =
 * failed, muted = cancelled or not started yet.
 */
export function RunStatusIcon({ status, className }: { status: RunStatus; className?: string }) {
  const cls = cn('h-3.5 w-3.5 shrink-0', className)
  if (status === 'succeeded') return <CheckCircle2 className={cn(cls, 'text-primary')} />
  if (status === 'failed') return <XCircle className={cn(cls, 'text-destructive')} />
  if (status === 'cancelled') return <Ban className={cn(cls, 'text-muted-foreground')} />
  if (status === 'running') return <Loader2 className={cn(cls, 'animate-spin text-primary')} />
  return <CircleDashed className={cn(cls, 'text-muted-foreground')} />
}
