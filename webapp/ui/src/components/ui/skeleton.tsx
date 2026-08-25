import { cn } from '@/lib/utils'

/**
 * The house loading surface.
 *
 * The app's pulse is `animate-subtle-pulse` (the one Panel's `loading` prop
 * uses on real content) — not Tailwind's stock `animate-pulse`, which beats
 * harder and had crept into a few skeleton blocks alongside two spinner
 * idioms and bare "Loading…" text. One vocabulary: a Skeleton where content
 * will appear, `Loader2` only inside a button or inline beside the action
 * that is busy.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-subtle-pulse rounded-md bg-foreground/[0.04]', className)} />
}

/** A stack of text-shaped lines, for prose or list placeholders. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-4', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}
