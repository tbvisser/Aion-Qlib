/**
 * The Strategy Builder's form primitives.
 *
 * Lifted out of StrategyBuilderPage unchanged when the canvas arrived, so the
 * form and the canvas inspector render a labelled control the same way rather
 * than drifting into two dialects of the same thing.
 */
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { MAX_BPS, fromBps, toBps } from '@/lib/bps'
import { cn } from '@/lib/utils'

export function Section({
  title, note, children,
}: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        {note && <p className="pt-1 text-xs text-muted-foreground">{note}</p>}
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">{children}</CardContent>
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
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 w-full rounded-lg border border-border/50 bg-background px-3 font-mono text-xs"
    />
  )
}

export function NumberInput({
  value, onChange, min, max, step = 1,
}: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <Input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (!Number.isNaN(n)) onChange(n)
      }}
      className="tnum font-mono text-xs"
    />
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
  return (
    <div className="relative">
      <Input
        type="number"
        value={toBps(value)}
        min={0}
        max={max}
        step={0.5}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!Number.isNaN(n)) onChange(fromBps(n))
        }}
        className="tnum pr-10 font-mono text-xs"
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        bps
      </span>
    </div>
  )
}
