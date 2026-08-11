/**
 * Which names a strategy trades, with the answer visible before you commit.
 *
 * The universe used to be a bare `Choice` of slugs — `top500`, `macro50`,
 * `etf_top100` — and nothing anywhere said how many names any of them held or
 * which ones. `GET /api/instruments?universe=` exists *specifically* for this,
 * per its own docstring, and the builder had never called it.
 *
 * Modelled on `macro/SeriesPicker`: a Popover over a closed list, with a search
 * that reaches inside the selected universe. `PortfolioDialog`'s free-text
 * typeahead is the wrong gesture here — there are eleven universes, not ten
 * thousand symbols, and the list itself is the thing worth reading.
 *
 * Membership is asked for **per store**. Without that the lookup resolves
 * against whichever store the API process mounted, so a crypto strategy would
 * be shown the US store's copy of `crypto_top100`.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronsUpDown, Search } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useStoreUniverses } from '@/hooks/useStoreUniverses'
import { api, type Instrument, type StoreUniverse } from '@/lib/api'
import { cn } from '@/lib/utils'

export function UniversePicker({ value, onChange, store, universes }: {
  value: string
  onChange: (universe: string) => void
  store: string
  /** The authoritative list, from `/data-stores`. This component only decorates it. */
  universes: string[]
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [members, setMembers] = useState<Instrument[] | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const detail = useStoreUniverses(store)

  const byName = useMemo(
    () => new Map(detail.map((u) => [u.name, u])), [detail])

  /**
   * Search inside the selected universe.
   *
   * Debounced and race-guarded with the `reqId` pattern from `MarketsPage`: a
   * slow response for "a" must not overwrite a fast one for "aapl".
   */
  const reqId = useRef(0)
  useEffect(() => {
    const needle = query.trim()
    if (!open || !needle) {
      setMembers(null)
      setTotal(null)
      return
    }
    const mine = ++reqId.current
    const t = setTimeout(() => {
      api.instruments({ universe: value, store, search: needle, limit: 50 })
        .then((r) => {
          if (mine !== reqId.current) return
          setMembers(r.instruments)
          setTotal(r.total)
        })
        .catch(() => { if (mine === reqId.current) setMembers([]) })
    }, 150)
    return () => clearTimeout(t)
  }, [query, value, store, open])

  const selected = byName.get(value)

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery('') }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="universe-picker"
          className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border/50 bg-background px-3 font-mono text-xs transition-colors hover:bg-foreground/[0.03]"
        >
          <span className="min-w-0 truncate">{value || '—'}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            {/* The count on the trigger, so the size is legible without opening. */}
            {selected && <Badge variant="outline">{selected.count.toLocaleString()}</Badge>}
            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-80 p-0">
        <div className="max-h-56 overflow-y-auto border-b border-border/50">
          {universes.map((name) => {
            const info = byName.get(name)
            const empty = info?.count === 0
            const on = name === value
            return (
              <button
                key={name}
                type="button"
                data-testid={`universe-${name}`}
                // aria-disabled, not disabled: a disabled button swallows hover,
                // and the title is the only place the reason is written down.
                aria-disabled={empty}
                title={empty
                  ? `This store's ${name}.txt is empty — nothing to trade`
                  : info
                    ? `${info.count.toLocaleString()} names`
                    : name}
                onClick={() => { if (!empty) { onChange(name); setOpen(false) } }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-xs',
                  empty ? 'cursor-not-allowed opacity-40' : 'hover:bg-foreground/[0.04]',
                  on && 'bg-foreground/[0.07]',
                )}
              >
                <span className="min-w-0 truncate">{name}</span>
                <span className="shrink-0 tnum text-[10px] text-muted-foreground">
                  {info ? info.count.toLocaleString() : '·'}
                </span>
              </button>
            )
          })}
        </div>

        <div className="border-b border-border/50 p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search inside ${value}`}
              className="h-8 pl-8 text-xs"
              data-testid="universe-member-search"
            />
          </div>
        </div>

        <div className="max-h-48 overflow-y-auto p-2">
          {members === null ? (
            <Peek universe={selected} />
          ) : members.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">
              No match in {value}.
            </p>
          ) : (
            <>
              {members.map((m) => (
                <div key={m.symbol} className="flex items-baseline gap-2 px-1 py-0.5 text-xs">
                  <span className="shrink-0 font-mono">{m.symbol}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{m.name}</span>
                </div>
              ))}
              {total !== null && total > members.length && (
                <p className="px-1 pt-1 text-[10px] text-muted-foreground">
                  showing {members.length} of {total.toLocaleString()}
                </p>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A few of the names, so the slug stops being an abstraction. */
function Peek({ universe }: { universe?: StoreUniverse }) {
  if (!universe) {
    return <p className="py-3 text-center text-xs text-muted-foreground">Loading…</p>
  }
  if (!universe.sample.length) {
    return (
      <p className="py-3 text-center text-xs text-muted-foreground">
        This store's {universe.name}.txt is empty.
      </p>
    )
  }
  const rest = universe.count - universe.sample.length
  return (
    <div className="flex flex-wrap gap-1">
      {universe.sample.map((symbol) => (
        <span
          key={symbol}
          className="rounded border border-border/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          {symbol}
        </span>
      ))}
      {rest > 0 && (
        <span className="px-1 py-0.5 font-mono text-[10px] text-muted-foreground/70">
          +{rest.toLocaleString()} more
        </span>
      )}
    </div>
  )
}
