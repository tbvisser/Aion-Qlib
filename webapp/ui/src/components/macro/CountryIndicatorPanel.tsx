import { Segmented } from '@/components/ui/segmented'
import { Sparkline } from '@/components/Sparkline'
import type { CountryIndicators } from '@/lib/api'
import { cn } from '@/lib/utils'

const COUNTRIES = [
  { value: 'USA', label: 'US' },
  { value: 'DEU', label: 'DE' },
  { value: 'GBR', label: 'GB' },
  { value: 'JPN', label: 'JP' },
  { value: 'CHN', label: 'CN' },
] as const

function format(value: number | null, unit: string): string {
  if (value == null) return '—'
  if (unit === 'percent') return `${value.toFixed(1)}%`
  if (unit === 'usd') {
    if (Math.abs(value) >= 1e12) return `$${(value / 1e12).toFixed(1)}T`
    if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(0)}B`
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  }
  if (unit === 'count') return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  return value.toFixed(1)
}

/**
 * Annual World Bank style indicators per country.
 *
 * Every value carries its year, and a year more than one behind the present is
 * marked in clay. Annual data rendered as "current" is the classic way this
 * kind of series misleads, and these are often two years stale.
 */
export function CountryIndicatorPanel({
  data, country, onCountryChange, loading,
}: {
  data: CountryIndicators | null
  country: string
  onCountryChange: (country: string) => void
  loading?: boolean
}) {
  const thisYear = new Date().getFullYear()

  return (
    <div className={cn(loading && 'animate-subtle-pulse')}>
      <div className="mb-3">
        <Segmented value={country} options={COUNTRIES} onChange={onCountryChange} size="sm" />
      </div>

      {!data ? (
        <div className="h-40" />
      ) : !data.available ? (
        <div className="rounded-lg border border-clay/40 bg-clay/5 p-3 text-sm">
          {data.reason ?? 'No country indicators cached yet.'}
        </div>
      ) : data.indicators.length === 0 ? (
        <p className="py-3 text-xs text-muted-foreground">No indicators for {data.country}.</p>
      ) : (
        <div className="space-y-2">
          {data.indicators.map((indicator) => {
            const stale = indicator.latest_year != null && indicator.latest_year < thisYear - 1
            const delta =
              indicator.latest != null && indicator.previous != null
                ? indicator.latest - indicator.previous
                : null
            return (
              <div
                key={indicator.key}
                className="flex items-center justify-between gap-2 border-b border-border/30 pb-2 last:border-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs">{indicator.label}</div>
                  <div className={cn('font-mono text-micro',
                    stale ? 'text-clay' : 'text-muted-foreground/70')}>
                    {indicator.latest_year ?? '—'}
                    {stale && ' · latest available'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Sparkline
                    values={indicator.history.slice(-20).map((h) => h.value)}
                    width={40}
                    height={14}
                  />
                  <div className="text-right">
                    <div className="tnum font-mono text-sm">
                      {format(indicator.latest, indicator.unit)}
                    </div>
                    {delta != null && indicator.unit === 'percent' && (
                      <div className={cn('tnum font-mono text-micro',
                        delta > 0 ? 'text-primary' : delta < 0 ? 'text-clay' : 'text-muted-foreground')}>
                        {delta > 0 ? '+' : ''}{delta.toFixed(1)}pp
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
