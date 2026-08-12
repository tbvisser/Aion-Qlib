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
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function Choice({
  value, onChange, options,
}: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="font-mono text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="font-mono text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function DateInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
        <p className="text-[11px] leading-relaxed text-clay">Enter a complete date.</p>
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
        <p className="text-[11px] leading-relaxed text-clay">{parsed.error}</p>
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
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          bps
        </span>
      </div>
      {parsed && !parsed.ok && (
        <p className="text-[11px] leading-relaxed text-clay">{parsed.error}</p>
      )}
    </div>
  )
}
