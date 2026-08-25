/**
 * The left rail's vocabulary: tabs, collapsible sections, and the row.
 *
 * The builder's rail, the template list and the backtest index were three
 * hand-rolled lists with three different row heights, three disclosure idioms
 * (a static caption, a raw `<details>`, a dropdown) and four copies of the same
 * pill. They are one surface to the person using them, so they get one set of
 * parts here.
 *
 * The row is deliberately single-line. A hundred-row factor library only reads
 * as a list you can scan if each entry is one line; everything the second line
 * used to carry — the summary, the caveat, the raw expression — moves into the
 * tooltip, which can afford to be longer than two clamped lines ever was.
 */
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface RailTab<T extends string> {
  value: T
  label: string
  /** Shown as the reason when the tab cannot be used. */
  disabledReason?: string
}

/**
 * The rail's top-level switch.
 *
 * Not `Segmented`: that is a bordered pill for choosing a *mode* inside a
 * panel, and this is a full-width switch between two halves of the rail. The
 * underline is what tells you the whole column below it changed.
 */
export function RailTabs<T extends string>({
  value, tabs, onChange, 'data-testid': testId,
}: {
  value: T
  tabs: readonly RailTab<T>[]
  onChange: (value: T) => void
  'data-testid'?: string
}) {
  return (
    <div
      role="tablist"
      data-testid={testId}
      className="flex shrink-0 border-b border-border/50"
    >
      {tabs.map((tab) => {
        const active = tab.value === value
        const off = !!tab.disabledReason
        return (
          <button
            key={tab.value}
            role="tab"
            aria-selected={active}
            // `aria-disabled`, not `disabled` — same rule `RailRow` follows
            // below, and for the same reason: a disabled button suppresses
            // hover, so the tooltip explaining why it cannot be used is the one
            // thing a disabled tab can never show.
            aria-disabled={off || undefined}
            title={tab.disabledReason}
            data-testid={`${testId ?? 'rail'}-tab-${tab.value}`}
            onClick={() => !off && onChange(tab.value)}
            className={cn(
              'flex-1 border-b-2 px-2 py-2.5 text-label uppercase tracking-wider transition-colors',
              off
                ? 'cursor-not-allowed border-transparent text-muted-foreground/40'
                : active
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A collapsible group of rows.
 *
 * `open` can be driven from outside — search results want every section
 * expanded regardless of what the reader last collapsed, and want it forgotten
 * again when the query clears.
 */
export function RailSection({
  label, count, defaultOpen = true, open: forcedOpen, children,
}: {
  label: string
  count?: number
  defaultOpen?: boolean
  open?: boolean
  children: React.ReactNode
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const open = forcedOpen ?? localOpen

  return (
    <div className="mb-3">
      <button
        onClick={() => setLocalOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-1 py-1.5 text-left text-micro uppercase tracking-wider text-muted-foreground/70 transition-colors hover:text-muted-foreground"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count != null && <span className="shrink-0 tabular-nums">{count}</span>}
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && <div>{children}</div>}
    </div>
  )
}

/**
 * One pickable thing.
 *
 * Unavailable rows carry `aria-disabled` rather than `disabled`: a disabled
 * button swallows pointer events, and the tooltip on an unavailable row is the
 * only place its reason is written down. Losing the reason to keep the
 * attribute would be the wrong trade.
 */
export function RailRow({
  label, badges, actions, tooltip, disabled, selected, onClick, 'data-testid': testId,
}: {
  label: React.ReactNode
  badges?: React.ReactNode
  /**
   * Controls shown over the badges on hover or keyboard focus.
   *
   * Rendered as a sibling of the row rather than inside it: the row is a
   * `<button>`, and a button inside a button is invalid and unclickable.
   */
  actions?: React.ReactNode
  tooltip?: React.ReactNode
  disabled?: boolean
  selected?: boolean
  onClick?: () => void
  'data-testid'?: string
}) {
  const row = (
    <button
      type="button"
      data-testid={testId}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={cn(
        'mb-1.5 flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors',
        // The border does the work in light mode, where `--surface-2` sits one
        // percentage point off `--background` and the fill alone is invisible.
        // In dark it is the fill that separates them and the border is trim.
        disabled
          ? 'cursor-not-allowed border-dashed border-clay/50 text-muted-foreground'
          : selected
            ? 'border-border bg-surface-3 text-foreground'
            : 'border-border/60 bg-surface-2 hover:bg-surface-3',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-body-sm">{label}</span>
      {badges}
    </button>
  )

  const body = actions ? (
    <div className="group relative">
      {row}
      {/* Opaque, so it covers the badges rather than colliding with them. */}
      <div className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-surface-3 pl-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        {actions}
      </div>
    </div>
  ) : row

  if (!tooltip) return body
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-sm px-3 py-2">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

/** The tooltip body every rail row uses: what it is, then what it costs you. */
export function RailTip({
  title, body, constraint, hint,
}: {
  title?: string
  body?: string | null
  constraint?: string | null
  hint?: string
}) {
  return (
    <div className="space-y-1">
      {/* Factor expressions run long and have no spaces to break on, so they
          are told to break anywhere rather than be clipped by the panel. */}
      {title && (
        <p className="break-all font-mono text-label leading-relaxed text-foreground">
          {title}
        </p>
      )}
      {body && <p className="text-label leading-relaxed text-popover-foreground">{body}</p>}
      {constraint && (
        <p className="text-label leading-relaxed text-clay">{constraint}</p>
      )}
      {hint && <p className="text-micro text-muted-foreground">{hint}</p>}
    </div>
  )
}
