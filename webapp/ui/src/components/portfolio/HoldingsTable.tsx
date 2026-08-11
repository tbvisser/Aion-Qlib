import { useState } from 'react'
import type { PortfolioContribution } from '@/lib/api'
import { formatPercent } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

type SortKey = 'symbol' | 'weight' | 'total_return' | 'contribution'

/**
 * Holdings with their weight, own return and contribution to the book.
 *
 * Hand-rolled with IndicatorsPage's exact table classes rather than a generic
 * shadcn Table — that page already established the app's table styling, and a
 * second one would be a third visual language for the same thing.
 */
export function HoldingsTable({ rows }: { rows: PortfolioContribution[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'weight', dir: -1 })

  if (!rows.length) {
    return <p className="py-8 text-center text-xs text-muted-foreground">No holdings.</p>
  }

  const sorted = [...rows].sort((a, b) => {
    const x = a[sort.key]
    const y = b[sort.key]
    // Nulls last, whichever direction we are sorting in.
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return typeof x === 'string' && typeof y === 'string'
      ? x.localeCompare(y) * sort.dir
      : ((x as number) - (y as number)) * sort.dir
  })

  const maxWeight = Math.max(...rows.map((r) => Math.abs(r.weight ?? 0)), 1e-9)

  const header = (key: SortKey, label: string, right = false) => (
    <th
      className={cn('cursor-pointer py-1 font-normal hover:text-foreground',
        right ? 'pl-2 text-right' : 'pr-2')}
      onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === -1 ? 1 : -1 }))}
    >
      {label}{sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
    </th>
  )

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-border/50 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {header('symbol', 'Symbol')}
          <th className="py-1 pr-2 font-normal">Class</th>
          {header('weight', 'Weight', true)}
          {header('total_return', 'Return', true)}
          {header('contribution', 'Contribution', true)}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr
            key={row.symbol}
            data-testid={`holding-${row.symbol}`}
            className="border-b border-border/30 last:border-0 hover:bg-foreground/[0.04]"
          >
            <td className="py-1.5 pr-2">
              <span className="font-mono text-xs">{row.symbol}</span>
              {row.name && (
                <span className="ml-2 truncate text-[10px] text-muted-foreground">
                  {row.name}
                </span>
              )}
            </td>
            <td className="py-1.5 pr-2 font-mono text-[10px] uppercase text-muted-foreground/70">
              {row.asset_class ?? '—'}
            </td>
            <td className="py-1.5 pl-2 text-right">
              <div className="relative inline-block w-20">
                <div
                  className="absolute inset-y-0 right-0 rounded-sm bg-primary/25"
                  style={{ width: `${(Math.abs(row.weight ?? 0) / maxWeight) * 100}%` }}
                />
                <span className="tnum relative font-mono text-xs">
                  {row.weight == null ? '—' : `${(row.weight * 100).toFixed(1)}%`}
                </span>
              </div>
            </td>
            <td className={cn('tnum py-1.5 pl-2 text-right font-mono text-xs',
              (row.total_return ?? 0) > 0 ? 'text-primary'
                : (row.total_return ?? 0) < 0 ? 'text-clay' : '')}>
              {formatPercent(row.total_return)}
            </td>
            <td className={cn('tnum py-1.5 pl-2 text-right font-mono text-xs',
              (row.contribution ?? 0) > 0 ? 'text-primary'
                : (row.contribution ?? 0) < 0 ? 'text-clay' : '')}>
              {formatPercent(row.contribution)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
