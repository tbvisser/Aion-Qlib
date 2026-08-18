import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import type { Portfolio } from '@/lib/api'
import { cn } from '@/lib/utils'

interface PortfolioListTabProps {
  portfolios: Portfolio[]
  loading?: boolean
}

export function PortfolioListTab({ portfolios, loading }: PortfolioListTabProps) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? portfolios.filter((p) => p.name.toLowerCase().includes(needle))
      : portfolios
  }, [portfolios, query])

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search portfolios"
          className="h-8 pl-8 text-xs"
        />
      </div>

      <div className={cn('space-y-1', loading && 'animate-subtle-pulse')}>
        {filtered.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {portfolios.length === 0 ? 'No portfolios yet.' : 'No matches.'}
          </p>
        ) : (
          filtered.map((portfolio) => (
            <Link
              key={portfolio.id}
              to={`/book/portfolios/${portfolio.id}`}
              className="block rounded-lg border border-border/50 bg-card p-3 transition-shadow hover:shadow-card"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{portfolio.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                    <span>{portfolio.base_ccy}</span>
                    <span>·</span>
                    <span>{portfolio.holdings.length} holdings</span>
                    {portfolio.strategy_ids.length > 0 && (
                      <>
                        <span>·</span>
                        <span>{portfolio.strategy_ids.length} strategies</span>
                      </>
                    )}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                  {portfolio.benchmark}
                </span>
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}
