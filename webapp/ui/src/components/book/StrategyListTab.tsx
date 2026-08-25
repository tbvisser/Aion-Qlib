import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import type { StoredStrategy } from '@/lib/api'
import { cn } from '@/lib/utils'

interface StrategyListTabProps {
  strategies: StoredStrategy[]
  loading?: boolean
}

export function StrategyListTab({ strategies, loading }: StrategyListTabProps) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? strategies.filter((s) => s.name.toLowerCase().includes(needle))
      : strategies
  }, [strategies, query])

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search strategies"
          className="h-8 pl-8 text-xs"
        />
      </div>

      <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', loading && 'animate-subtle-pulse')}>
        {filtered.length === 0 ? (
          <p className="col-span-full p-4 text-center text-xs text-muted-foreground">
            {strategies.length === 0 ? 'No strategies saved yet.' : 'No matches.'}
          </p>
        ) : (
          filtered.map((strategy) => (
            <Link
              key={strategy.id}
              to={`/book/strategies/${strategy.id}`}
              className="block rounded-lg border border-border/50 bg-card p-3 transition-shadow hover:shadow-card"
            >
              <div className="truncate text-sm font-medium">{strategy.name}</div>
              <div className="mt-0.5 font-mono text-micro text-muted-foreground">
                {strategy.model} · {strategy.handler} · {strategy.universe}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <FeatureBadge
                  active={Boolean(strategy.features && strategy.features.length > 0)}
                  label={strategy.features && strategy.features.length > 0
                    ? `${strategy.features.length} custom feature${strategy.features.length === 1 ? '' : 's'}`
                    : 'handler default'}
                />
                <FeatureBadge
                  active={strategy.visibility === 'org'}
                  label={strategy.visibility === 'org' ? 'shared' : 'private'}
                />
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  )
}

function FeatureBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span className={cn(
      'inline-flex items-center rounded-md border px-1.5 py-0.5 text-micro',
      active
        ? 'border-primary/30 bg-primary/10 text-foreground'
        : 'border-border/50 bg-foreground/[0.02] text-muted-foreground',
    )}>
      {label}
    </span>
  )
}
