/**
 * The AION symbol, theme-aware.
 *
 * The brand ships as static SVGs rather than components (`public/brand/`), so
 * every render site was its own `<img>` with its own hardcoded colourway —
 * `LoginPage` switched on theme, the Dashboard hero did not and stayed mint on
 * a cream background. One component, one rule.
 *
 * `thinking` is the app's own `animate-subtle-pulse` (opacity 1 → 0.6), the
 * same signal `ToolCard` and the run panel already use for "this is in
 * flight". The mark rather than a spinner because what is thinking is AION,
 * and a bare "Thinking…" string said so in the least legible way available.
 */
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'

export function AionMark({ className, thinking, alt = 'AION' }: {
  className?: string
  thinking?: boolean
  /** Empty when the mark sits beside its own wordmark, or is decorative. */
  alt?: string
}) {
  const { theme } = useTheme()
  return (
    <img
      src={theme === 'dark' ? '/brand/aion-symbol-mint.svg' : '/brand/aion-symbol-ink.svg'}
      alt={alt}
      aria-hidden={alt === '' || undefined}
      className={cn('h-4 w-auto shrink-0', thinking && 'animate-subtle-pulse', className)}
    />
  )
}
