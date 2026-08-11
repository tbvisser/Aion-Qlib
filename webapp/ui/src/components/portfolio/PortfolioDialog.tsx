import { useEffect, useRef, useState } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  DEFAULT_PORTFOLIO, api, type AssetClassKey, type BaseCurrency, type Instrument,
  type Portfolio, type PortfolioHolding, type PortfolioSpec, type Rebalance,
} from '@/lib/api'
import { cn } from '@/lib/utils'

const CURRENCIES: BaseCurrency[] = ['USD', 'EUR', 'GBP', 'JPY', 'CHF']
const REBALANCES: Rebalance[] = ['none', 'monthly', 'quarterly', 'annual']

/**
 * A stored portfolio, back down to the shape the API accepts.
 *
 * `PortfolioSpec` is `extra="forbid"` (api/portfolios.py:53) and `StoredPortfolio`
 * adds `id`, `created_at` and `updated_at`. Seeding the editor with the whole
 * stored record therefore sent all three back, and every PUT — and every
 * live-validate POST — 422'd on `extra_forbidden`. Editing a portfolio was
 * impossible; creating one was fine, because the defaults carry no extra keys.
 */
function toSpec({ id: _id, created_at: _c, updated_at: _u, ...spec }: Portfolio): PortfolioSpec {
  return spec
}

/**
 * Create or edit a portfolio.
 *
 * The weight sum is shown live and is *not* enforced: 87% is a meaningful
 * 13%-cash book and 104% is a geared one. Over-allocation renders in clay —
 * a bad number, not an error — and saving is still allowed, because the
 * backend decides what is valid, not the form.
 */
export function PortfolioDialog({
  portfolio, open, onOpenChange, onSave,
}: {
  /** Undefined means create. */
  portfolio?: Portfolio
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (spec: PortfolioSpec, id?: string) => Promise<unknown>
}) {
  const [spec, setSpec] = useState<PortfolioSpec>(DEFAULT_PORTFOLIO)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSpec(portfolio ? toSpec(portfolio) : { ...DEFAULT_PORTFOLIO, holdings: [] })
  }, [open, portfolio])

  const total = spec.holdings.reduce((sum, h) => sum + (Number(h.weight) || 0), 0)
  const patch = (updates: Partial<PortfolioSpec>) => setSpec((s) => ({ ...s, ...updates }))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await onSave(spec, portfolio?.id)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="portfolio-dialog">
        <DialogHeader>
          <DialogTitle>{portfolio ? 'Edit portfolio' : 'New portfolio'}</DialogTitle>
          <DialogDescription>
            Weights are targets as a fraction of NAV. The NAV is computed from real
            bars, so every symbol has to exist in a data store.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                value={spec.name}
                onChange={(e) => patch({ name: e.target.value })}
                className="h-8 text-xs"
              />
            </Field>
            <Field label="Benchmark">
              <Input
                value={spec.benchmark}
                onChange={(e) => patch({ benchmark: e.target.value.toUpperCase() })}
                className="h-8 font-mono text-xs"
              />
            </Field>
            <Field label="Base currency">
              <Select
                value={spec.base_ccy}
                onValueChange={(v) => patch({ base_ccy: v as BaseCurrency })}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Rebalance">
              <Select
                value={spec.rebalance}
                onValueChange={(v) => patch({ rebalance: v as Rebalance })}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REBALANCES.map((r) => (
                    <SelectItem key={r} value={r} className="text-xs">{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Inception">
              <Input
                type="date"
                value={spec.inception}
                onChange={(e) => patch({ inception: e.target.value })}
                className="h-8 font-mono text-xs"
              />
            </Field>
            <Field label="Cost (bp per rebalance)">
              <Input
                type="number" min={0} max={500}
                value={spec.cost_bps}
                onChange={(e) => patch({ cost_bps: Number(e.target.value) })}
                className="h-8 font-mono text-xs"
              />
            </Field>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                Holdings
              </Label>
              <span className={cn('tnum font-mono text-[11px]',
                Math.abs(total - 1) < 0.005 ? 'text-muted-foreground'
                  : total > 1 ? 'text-clay' : 'text-muted-foreground')}>
                {(total * 100).toFixed(1)}% allocated
                {total < 0.995 && ` · ${((1 - total) * 100).toFixed(1)}% cash`}
              </span>
            </div>

            <div className="space-y-1.5">
              {spec.holdings.map((holding, i) => (
                <HoldingRow
                  key={i}
                  holding={holding}
                  onChange={(next) => patch({
                    holdings: spec.holdings.map((h, j) => (j === i ? next : h)),
                  })}
                  onRemove={() => patch({
                    holdings: spec.holdings.filter((_, j) => j !== i),
                  })}
                />
              ))}
            </div>

            <Button
              type="button" variant="outline" size="sm"
              className="mt-2 h-7 text-xs"
              onClick={() => patch({
                holdings: [...spec.holdings,
                  { symbol: '', asset_class: 'etf' as AssetClassKey, weight: 0 }],
              })}
            >
              <Plus className="mr-1 h-3 w-3" /> Add holding
            </Button>
          </div>

          <Field label="Notes">
            <Input
              value={spec.notes}
              onChange={(e) => patch({ notes: e.target.value })}
              placeholder="What this book is for"
              className="h-8 text-xs"
            />
          </Field>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving || !spec.name.trim() || spec.holdings.length === 0}
          >
            {saving ? 'Saving…' : portfolio ? 'Save changes' : 'Create portfolio'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </Label>
      {children}
    </div>
  )
}

/** One holding: a debounced symbol typeahead plus a weight. */
function HoldingRow({
  holding, onChange, onRemove,
}: {
  holding: PortfolioHolding
  onChange: (next: PortfolioHolding) => void
  onRemove: () => void
}) {
  const [query, setQuery] = useState(holding.symbol)
  const [matches, setMatches] = useState<Instrument[]>([])
  const [openList, setOpenList] = useState(false)
  const reqId = useRef(0)

  useEffect(() => {
    const needle = query.trim()
    if (!needle || needle === holding.symbol) {
      setMatches([])
      return
    }
    const id = ++reqId.current
    const timer = setTimeout(() => {
      void api.instruments({ search: needle, limit: 8 })
        .then((r) => {
          // Race guard: a slow earlier search must not overwrite a newer one.
          if (id === reqId.current) setMatches(r.instruments)
        })
        .catch(() => { if (id === reqId.current) setMatches([]) })
    }, 200)
    return () => clearTimeout(timer)
  }, [query, holding.symbol])

  const pick = (instrument: Instrument) => {
    onChange({
      ...holding,
      symbol: instrument.symbol,
      asset_class: instrument.asset_class,
    })
    setQuery(instrument.symbol)
    setMatches([])
    setOpenList(false)
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpenList(true)
            onChange({ ...holding, symbol: e.target.value.toUpperCase() })
          }}
          onFocus={() => setOpenList(true)}
          onBlur={() => setTimeout(() => setOpenList(false), 150)}
          placeholder="Symbol"
          className="h-8 pl-7 font-mono text-xs"
        />
        {openList && matches.length > 0 && (
          <div className="absolute left-0 right-0 top-9 z-50 max-h-44 overflow-y-auto rounded-lg border border-border bg-popover shadow-card">
            {matches.map((m) => (
              <button
                key={`${m.symbol}-${m.asset_class}`}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); pick(m) }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-foreground/[0.04]"
              >
                <span className="font-mono text-xs">{m.symbol}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {m.name}
                </span>
                <span className="font-mono text-[9px] uppercase text-muted-foreground/60">
                  {m.asset_class}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <Input
        type="number" step="0.01" min={-2} max={2}
        value={holding.weight}
        onChange={(e) => onChange({ ...holding, weight: Number(e.target.value) })}
        className="h-8 w-24 font-mono text-xs"
        aria-label="Weight"
      />
      <Button
        type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0"
        onClick={onRemove} aria-label="Remove holding"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
