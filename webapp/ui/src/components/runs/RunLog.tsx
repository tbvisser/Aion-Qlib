import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import { cn } from '@/lib/utils'

/** How close to the bottom still counts as "following the tail". */
const STICK_PX = 24

/**
 * The run's terminal output. `className` sizes the container; the `<pre>` fills it.
 *
 * It follows the tail only while the reader is already at the bottom. Scrolling
 * up to read an error mid-run must not be undone a second later by the next
 * batch of lines — which is exactly what an unconditional scroll-to-bottom did.
 */
export function RunLog({ lines, className }: { lines: string[]; className?: string }) {
  const ref = useRef<HTMLPreElement>(null)
  const [following, setFollowing] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el || !following) return
    el.scrollTo({ top: el.scrollHeight })
  }, [lines, following])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX)
  }

  const jump = () => {
    setFollowing(true)
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
  }

  return (
    <div className={cn('relative', className)}>
      <pre
        ref={ref}
        data-testid="run-log"
        onScroll={onScroll}
        className="h-full overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-micro leading-relaxed"
      >
        {lines.join('\n') || 'Waiting for output…'}
      </pre>

      {!following && (
        <button
          onClick={jump}
          className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full border border-border/50 bg-card px-2.5 py-1 font-mono text-micro uppercase tracking-wider text-muted-foreground shadow-card transition-colors hover:text-foreground"
        >
          <ArrowDownToLine className="h-3 w-3" />
          Jump to latest
        </button>
      )}
    </div>
  )
}
