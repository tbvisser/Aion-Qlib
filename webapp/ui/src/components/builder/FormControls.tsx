/**
 * The Strategy Builder's form primitives.
 *
 * Lifted out of StrategyBuilderPage unchanged when the canvas arrived, so the
 * form and the canvas inspector render a labelled control the same way rather
 * than drifting into two dialects of the same thing.
 */
import { useState } from 'react'

import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MicroLabel } from '@/components/ui/micro-label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { MAX_BPS, fromBps, toBps } from '@/lib/bps'
import { parseNumberField } from '@/lib/numberField'
import { cn } from '@/lib/utils'

export function Section({
  title, note, columns = 2, children,
}: {
  title: string
  note?: string
  /**
   * Fields per row.
   *
   * `sm:grid-cols-2` is a *viewport* breakpoint, so a Section inside a 320px
   * rail on a wide screen lays itself out in two columns and every control
   * comes out half-width. The stage inspectors pass `1` for that reason.
   */
  columns?: 1 | 2
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        {note && <p className="pt-1 text-xs text-muted-foreground">{note}</p>}
      </CardHeader>
      <CardContent className={cn('grid gap-4', columns === 2 && 'sm:grid-cols-2')}>
        {children}
      </CardContent>
    </Card>
  )
}

export function Field({
  label, hint, className, children,
}: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <MicroLabel as="div">
        {label}
      </MicroLabel>
      {children}
      {hint && <p className="text-label text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * One value the control offers. `enabled` and `reason` are optional so every
 * existing caller passing bare `{value, label}` keeps working unchanged.
 */
export interface ChoiceOption {
  value: string
  label: string
  /** Defaults to true. False renders the row greyed, with `reason` beneath. */
  enabled?: boolean
  /** Why this value cannot be picked here. Required in practice when disabled. */
  reason?: string | null
}

/**
 * A dropdown that shows what it will not accept, and says why.
 *
 * Incompatible values are rendered rather than filtered out. A list that
 * quietly omits them hides the shape of the system: the reader cannot tell
 * whether `SPY` is missing because this store lacks it or because they
 * misremembered the name, and a wrong early pick becomes a dead end with no
 * sign that anything was lost.
 *
 * They are marked with `aria-disabled` and refused at `onValueChange`, *not*
 * with Radix's `disabled`. Radix drops a disabled item out of keyboard
 * navigation and typeahead entirely — so the one mechanism that would read the
 * reason aloud is the one that can no longer reach it. Same choice, and the
 * same reasoning, as the universe rows in `UniverseInspector`.
 */
export function Choice({
  value, onChange, options,
}: { value: string; onChange: (v: string) => void; options: ChoiceOption[] }) {
  const allowed = new Set(options.filter((o) => o.enabled !== false).map((o) => o.value))

  return (
    <Select value={value} onValueChange={(v) => { if (allowed.has(v)) onChange(v) }}>
      <SelectTrigger className="font-mono text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => {
          const off = o.enabled === false
          return (
            <SelectItem
              key={o.value}
              value={o.value}
              aria-disabled={off || undefined}
              title={off ? o.reason ?? undefined : undefined}
              className={cn('font-mono text-xs', off && 'opacity-55')}
            >
              <span className="flex flex-col gap-0.5 text-left">
                <span className={cn(off && 'line-through decoration-clay/60')}>
                  {o.label}
                </span>
                {off && o.reason && (
                  <span className="max-w-[22rem] whitespace-normal font-sans text-label
                                   leading-snug text-muted-foreground">
                    {o.reason}
                  </span>
                )}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

/**
 * What is wrong with one field, and the ways out of it.
 *
 * Renders nothing when there is nothing to say, so every inspector can mount it
 * under every control unconditionally.
 *
 * The ways out live here rather than inside the dropdown for two reasons: a
 * button inside a Radix `SelectItem` fights the item's own click, and a
 * resolution that changes a *different* field — "switch to the us store" —
 * has no business being an option in this field's list. Each one says what it
 * preserves, because the choice between them is exactly the thing the reader
 * knows and the builder does not.
 */
export function FieldProblem({
  messages, resolutions, onApply,
}: {
  messages: readonly string[]
  resolutions?: readonly { label: string; preserves: string; patch: Record<string, unknown> }[]
  onApply?: (patch: Record<string, unknown>) => void
}) {
  if (!messages.length && !resolutions?.length) return null

  return (
    <div className="space-y-1.5 rounded-lg border border-clay/30 bg-clay/5 p-2">
      {messages.map((m) => (
        <p key={m} className="text-label leading-snug text-clay">{m}</p>
      ))}
      {!!resolutions?.length && onApply && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {resolutions.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => onApply(r.patch)}
              className="rounded-md border border-border/60 bg-background px-2 py-1
                         text-left text-label leading-tight hover:border-primary/50"
            >
              <span className="block font-medium">{r.label}</span>
              {r.preserves && (
                <span className="block text-muted-foreground">{r.preserves}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function DateInput({
  value, onChange, max,
}: {
  value: string
  onChange: (v: string) => void
  /**
   * The last date the store can safely backtest, when one is known.
   *
   * Advisory in the browser — a native date input marks a value past `max` as
   * invalid and still lets it be typed, and that is the right strength here:
   * the backend clamps rather than refuses, so the field must not become
   * uneditable over something the run survives.
   */
  max?: string
}) {
  /**
   * '' while the field is cleared or mid-edit. Never committed: a date input
   * reports '' until its segments make a real date, and writing that into the
   * spec 422s the preview with nothing on screen naming this field.
   */
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <div className="space-y-1">
      <input
        type="date"
        max={max}
        value={draft ?? value}
        onChange={(e) => {
          const v = e.target.value
          if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
            setDraft(null)
            onChange(v)
          } else {
            setDraft(v)
          }
        }}
        className="h-10 w-full rounded-lg border border-border/50 bg-background px-3 font-mono text-xs"
      />
      {draft !== null && (
        <p className="text-label leading-relaxed text-clay">Enter a complete date.</p>
      )}
    </div>
  )
}

/**
 * A number the spec range-checks, refused here rather than by a 422.
 *
 * The field shows exactly what is being typed; only a value inside the bounds
 * is committed. An invalid draft stays visible beside its error — the spec
 * keeps the last good value, so the canvas card and the preview never carry
 * the junk — and a valid one snaps back to the canonical value on blur.
 */
export function NumberInput({
  value, onChange, min, max, step = 1,
}: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  const [draft, setDraft] = useState<string | null>(null)
  const parsed = draft === null ? null : parseNumberField(draft, { min, max })

  return (
    <div className="space-y-1">
      <Input
        type="number"
        value={draft ?? value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const text = e.target.value
          setDraft(text)
          const next = parseNumberField(text, { min, max })
          if (next.ok) onChange(next.value)
        }}
        onBlur={() => {
          if (draft !== null && parseNumberField(draft, { min, max }).ok) setDraft(null)
        }}
        className="tnum font-mono text-xs"
      />
      {parsed && !parsed.ok && (
        <p className="text-label leading-relaxed text-clay">{parsed.error}</p>
      )}
    </div>
  )
}

/**
 * A trading cost, edited in basis points and stored as a fraction.
 *
 * The spec carries `0.0005` because that is what qlib's `exchange_kwargs`
 * takes. Nobody says "five ten-thousandths of notional"; they say "5 bps". The
 * wire format is untouched — this is presentation only, and `lib/bps` owns the
 * rounding that keeps a focus/blur from perturbing a saved spec.
 */
export function BpsInput({
  value, onChange, max = MAX_BPS,
}: { value: number; onChange: (fraction: number) => void; max?: number }) {
  // Same draft rule as `NumberInput`, in this control's own unit: the bounds
  // are checked in bps, because that is what the field says and what the
  // error sentence has to speak.
  const [draft, setDraft] = useState<string | null>(null)
  const parsed = draft === null ? null : parseNumberField(draft, { min: 0, max })

  return (
    <div className="space-y-1">
      <div className="relative">
        <Input
          type="number"
          value={draft ?? toBps(value)}
          min={0}
          max={max}
          step={0.5}
          onChange={(e) => {
            const text = e.target.value
            setDraft(text)
            const next = parseNumberField(text, { min: 0, max })
            if (next.ok) onChange(fromBps(next.value))
          }}
          onBlur={() => {
            if (draft !== null && parseNumberField(draft, { min: 0, max }).ok) setDraft(null)
          }}
          className="tnum pr-10 font-mono text-xs"
        />
        <MicroLabel className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
          bps
        </MicroLabel>
      </div>
      {parsed && !parsed.ok && (
        <p className="text-label leading-relaxed text-clay">{parsed.error}</p>
      )}
    </div>
  )
}

/**
 * A number whose empty field is a real value — null — rather than an error.
 *
 * `NumberInput`'s draft snaps back on blur because its fields always hold a
 * number; here clearing the field *is* the edit. Lives beside its three
 * draft-and-commit siblings rather than in the one inspector that first needed
 * it, so a fix to the pattern reaches all four.
 */
export function NullableNumberInput({
  value, onChange, min = 0, step = 0.05, placeholder = 'No limit',
}: {
  value: number | null
  onChange: (v: number | null) => void
  min?: number
  step?: number
  placeholder?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const parsed = draft === null ? null : parseNumberField(draft, { min })

  return (
    <div className="space-y-1">
      <Input
        type="number"
        value={draft ?? (value === null ? '' : value)}
        min={min}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          const text = e.target.value
          if (text.trim() === '') {
            setDraft(null)
            onChange(null)
            return
          }
          setDraft(text)
          const next = parseNumberField(text, { min })
          if (next.ok) onChange(next.value)
        }}
        onBlur={() => {
          if (draft !== null && parseNumberField(draft, { min }).ok) setDraft(null)
        }}
        className="tnum font-mono text-xs"
      />
      {parsed && !parsed.ok && (
        <p className="text-label leading-relaxed text-clay">{parsed.error}</p>
      )}
    </div>
  )
}
