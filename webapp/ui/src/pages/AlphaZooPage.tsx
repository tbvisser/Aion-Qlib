import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Notice } from '@/components/ui/notice'
import { Input } from '@/components/ui/input'
import { api, type VibeAlpha } from '@/lib/api'
import { deriveFacets, filterAlphas, normalizeAlpha, sortAlphas } from '@/lib/alphaZoo'

/**
 * Alpha Zoo — browsable catalog of academic and practitioner alpha factors
 * served by the Vibe-Trading sidecar through the /vibe proxy. The sidecar
 * must be running; the page shows a calm instruction card otherwise.
 */
export function AlphaZooPage() {
  const [allItems, setAllItems] = useState<VibeAlpha[]>([])
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)

  // ── filter state ──────────────────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [selectedZoo, setSelectedZoo] = useState<string | null>(null)
  const [selectedTheme, setSelectedTheme] = useState<string | null>(null)
  const [selectedUniverse, setSelectedUniverse] = useState<string | null>(null)

  // ── expanded row ──────────────────────────────────────────────────────────
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // ── fetch ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setOffline(false)

    void (async () => {
      // Probe the sidecar first — a clear offline state is more actionable than
      // a raw fetch error bubbling through the list call.
      try {
        const health = await api.vibeHealth()
        if (cancelled) return
        if (health.status !== 'ok') {
          setOffline(true)
          setLoading(false)
          return
        }
      } catch {
        if (!cancelled) { setOffline(true); setLoading(false) }
        return
      }

      try {
        const resp = await api.vibeAlphaList()
        if (cancelled) return
        setAllItems(resp.result.result.items.map(normalizeAlpha))
      } catch {
        if (!cancelled) setOffline(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [])

  // ── derived ───────────────────────────────────────────────────────────────
  const facets = useMemo(() => deriveFacets(allItems), [allItems])

  const filtered = useMemo(
    () => sortAlphas(
      filterAlphas(allItems, {
        search,
        zoo: selectedZoo,
        theme: selectedTheme,
        universe: selectedUniverse,
      }),
      'nickname',
    ),
    [allItems, search, selectedZoo, selectedTheme, selectedUniverse],
  )

  const hasActiveFilter =
    search.trim() !== '' ||
    selectedZoo !== null ||
    selectedTheme !== null ||
    selectedUniverse !== null

  const clearFilters = () => {
    setSearch('')
    setSelectedZoo(null)
    setSelectedTheme(null)
    setSelectedUniverse(null)
  }

  const toggleRow = (id: string) =>
    setExpandedId((prev) => (prev === id ? null : id))

  return (
    <>
      <PageHeader
        title="Alpha Zoo"
        description="Academic and practitioner alpha factors from the Vibe-Trading research library. Click any row to inspect the formula, required columns, and construction notes."
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-5xl space-y-4">

          {/* ── Sidecar offline ──────────────────────────────────────────── */}
          {offline && !loading && (
            <Notice tone="muted" icon={false}>
              <p className="font-medium text-foreground">Vibe sidecar is not reachable</p>
              <p className="mt-1 text-[13px]">
                The Alpha Zoo requires the Vibe-Trading sidecar. Start it with:
              </p>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
                docker compose up -d vibe-api vibe-mcp
              </pre>
              <p className="mt-2 text-[12px] text-muted-foreground">
                Once running, reload this page to browse the catalog.
              </p>
            </Notice>
          )}

          {/* ── Filter row ───────────────────────────────────────────────── */}
          {!offline && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search id, nickname, notes…"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
                <FacetSelect
                  label="Zoo"
                  options={facets.zoos}
                  value={selectedZoo}
                  onChange={setSelectedZoo}
                  disabled={loading}
                />
                <FacetSelect
                  label="Theme"
                  options={facets.themes}
                  value={selectedTheme}
                  onChange={setSelectedTheme}
                  disabled={loading}
                />
                <FacetSelect
                  label="Universe"
                  options={facets.universes}
                  value={selectedUniverse}
                  onChange={setSelectedUniverse}
                  disabled={loading}
                />
                {hasActiveFilter && (
                  <button
                    onClick={clearFilters}
                    className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                    Clear
                  </button>
                )}
              </div>

              {/* ── Count line ─────────────────────────────────────────────── */}
              {!loading && allItems.length > 0 && (
                <p className="font-mono text-[11px] text-muted-foreground">
                  {allItems.length} alphas
                  {hasActiveFilter && (
                    <> · <span className="text-foreground">{filtered.length} shown</span></>
                  )}
                </p>
              )}

              {/* ── Loading skeleton ──────────────────────────────────────── */}
              {loading && (
                <Card>
                  <CardContent className="space-y-1 p-2">
                    {Array.from({ length: 12 }, (_, i) => (
                      <div key={i} className="h-10 animate-pulse rounded-md bg-muted/60" />
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* ── Results ───────────────────────────────────────────────── */}
              {!loading && (
                <Card>
                  {filtered.length === 0 ? (
                    <CardContent className="py-12 text-center text-sm text-muted-foreground">
                      {allItems.length === 0
                        ? 'No alphas were returned by the sidecar.'
                        : 'No alphas match the current filters.'}
                    </CardContent>
                  ) : (
                    <CardContent className="p-2">
                      {filtered.map((item) => (
                        <AlphaRow
                          key={item.id}
                          item={item}
                          expanded={expandedId === item.id}
                          onToggle={() => toggleRow(item.id)}
                        />
                      ))}
                    </CardContent>
                  )}
                </Card>
              )}
            </>
          )}

        </div>
      </div>
    </>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function FacetSelect({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string
  options: { value: string; count: number }[]
  value: string | null
  onChange: (v: string | null) => void
  disabled?: boolean
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled}
      className="h-8 rounded-lg border border-border/50 bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring/20 disabled:opacity-50"
    >
      <option value="">{label}</option>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.value} ({opt.count})
        </option>
      ))}
    </select>
  )
}

function AlphaRow({
  item,
  expanded,
  onToggle,
}: {
  item: VibeAlpha
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="block w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            {/* Top line: nickname + zoo badge + theme tags */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13px] font-medium leading-snug">{item.nickname}</span>
              <Badge variant="muted">{item.zoo}</Badge>
              {item.theme.map((t) => (
                <Badge key={t} variant="outline">{t}</Badge>
              ))}
            </div>
            {/* Bottom line: id + universes (clipped) + decay */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">{item.id}</span>
              {item.universe.slice(0, 3).map((u) => (
                <span key={u} className="font-mono text-[10px] text-muted-foreground/60">{u}</span>
              ))}
              {item.universe.length > 3 && (
                <span className="font-mono text-[10px] text-muted-foreground/50">
                  +{item.universe.length - 3}
                </span>
              )}
              {item.decay_horizon !== null && (
                <span className="font-mono text-[10px] text-muted-foreground/60">
                  decay {item.decay_horizon}d
                </span>
              )}
            </div>
          </div>
          <div className="mt-0.5 shrink-0 text-muted-foreground/40">
            {expanded
              ? <ChevronUp className="h-3.5 w-3.5" />
              : <ChevronDown className="h-3.5 w-3.5" />}
          </div>
        </div>
      </button>

      {/* ── Expanded detail ─────────────────────────────────────────────── */}
      {expanded && (
        <div className="mx-3 mb-2 space-y-3 rounded-md border border-border/40 bg-muted/20 px-3 py-3">
          {item.formula_latex && (
            <section>
              <SectionLabel>Formula (LaTeX)</SectionLabel>
              <code className="mt-1 block whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/80">
                {item.formula_latex}
              </code>
            </section>
          )}

          <section className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
            <MetaField
              label="Columns"
              value={item.columns_required.length ? item.columns_required.join(', ') : '—'}
            />
            {item.extras_required.length > 0 && (
              <MetaField label="Extras" value={item.extras_required.join(', ')} />
            )}
            <MetaField
              label="Warmup"
              value={item.min_warmup_bars !== null ? `${item.min_warmup_bars} bars` : '—'}
            />
            <MetaField
              label="Decay horizon"
              value={item.decay_horizon !== null ? `${item.decay_horizon}d` : '—'}
            />
            <MetaField
              label="Frequency"
              value={item.frequency.length ? item.frequency.join(', ') : '—'}
            />
            <MetaField label="Sector req." value={item.requires_sector ? 'yes' : 'no'} />
          </section>

          {item.universe.length > 0 && (
            <section>
              <SectionLabel>Universe</SectionLabel>
              <div className="mt-1 flex flex-wrap gap-1">
                {item.universe.map((u) => (
                  <Badge key={u} variant="outline">{u}</Badge>
                ))}
              </div>
            </section>
          )}

          {item.notes && (
            <section>
              <SectionLabel>Notes</SectionLabel>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                {item.notes}
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60">
      {children}
    </p>
  )
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/60">
        {label}
      </p>
      <p className="mt-0.5 font-mono text-[11px] text-foreground/80">{value}</p>
    </div>
  )
}
