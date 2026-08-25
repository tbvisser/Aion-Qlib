import { useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The app's canonical mode switch, extracted from the copy of it in
 * MarketsPage, DatabankPage, IndicatorsPage and the builder's ModeToggle.
 *
 * Deliberately not Radix Tabs. This idiom is already the established gesture
 * for switching a panel — adding Tabs would give the app two visual languages
 * for one action. What
 * Radix would have contributed is keyboard support, so that is here: roving
 * arrow keys and radiogroup semantics.
 */
export interface SegmentedOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
  title?: string
  /** Optional glyph before the label, for switches that read as destinations
   *  rather than as settings. Omit it and the option renders as before. */
  icon?: LucideIcon
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
  stretch = false,
  // Sidebar-sans, like every other navigation control. Mono is for data.
  buttonClassName = 'font-medium',
  'data-testid': testId,
}: {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  className?: string
  size?: 'sm' | 'md'
  /** Share the container's width evenly between the options, for a switch that
   *  fills a column rather than sitting inline beside a heading. */
  stretch?: boolean
  /** Applied to every option button so a consumer can override the default
   *  monospace typeface without changing the component globally. */
  buttonClassName?: string
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
        const Icon = option.icon
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
              'inline-flex items-center justify-center gap-1.5 rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              size === 'sm' ? 'px-2 py-0.5 text-micro' : 'px-2.5 py-1 text-label',
              stretch && 'flex-1',
              active
                ? 'bg-foreground/[0.07] text-foreground'
                : 'text-muted-foreground hover:text-foreground',
              buttonClassName,
            )}
          >
            {Icon && <Icon className={cn('shrink-0', size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5')} />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
