import { useRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * The app's canonical mode switch, extracted from the copy of it in
 * MarketsPage, DatabankPage, IndicatorsPage and the builder's ModeToggle.
 *
 * Deliberately not Radix Tabs. `@radix-ui/react-tabs` is installed but unused,
 * and this idiom is already the established gesture for switching a panel —
 * adding Tabs would give the app two visual languages for one action. What
 * Radix would have contributed is keyboard support, so that is here: roving
 * arrow keys and radiogroup semantics.
 */
export interface SegmentedOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
  title?: string
  /** Per-option hook, so a hand-rolled switch can be replaced without
   *  invalidating the selectors that already point at its buttons. */
  testId?: string
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = 'md',
  'data-testid': testId,
}: {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  className?: string
  size?: 'sm' | 'md'
  'data-testid'?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  const move = (delta: number) => {
    const usable = options.filter((o) => !o.disabled)
    if (!usable.length) return
    const at = Math.max(0, usable.findIndex((o) => o.value === value))
    const next = usable[(at + delta + usable.length) % usable.length]
    onChange(next.value)
    // Keep focus on the control the user is driving.
    const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('button')
    buttons?.[options.findIndex((o) => o.value === next.value)]?.focus()
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      data-testid={testId}
      className={cn(
        'flex w-fit items-center gap-1 rounded-lg border border-border/50 p-0.5',
        className,
      )}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          move(1)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          move(-1)
        }
      }}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            disabled={option.disabled}
            data-testid={option.testId}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md font-mono transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-2.5 py-1 text-[11px]',
              active
                ? 'bg-foreground/[0.07] text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
