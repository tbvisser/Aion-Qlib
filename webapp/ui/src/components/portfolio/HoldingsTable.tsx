import { useState } from 'react'
import type { PortfolioContribution } from '@/lib/api'
import { formatPercent } from '@/lib/macroFormat'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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
    <TableHeader numeric={right}>
      <button
        type="button"
        className="cursor-pointer hover:text-foreground"
        onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === -1 ? 1 : -1 }))}
      >
        {label}{sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
      </button>
    </TableHeader>
  )

  return (
    <Table>
      <TableHead>
        <tr>
          {header('symbol', 'Symbol')}
          <TableHeader>Class</TableHeader>
          {header('weight', 'Weight', true)}
          {header('total_return', 'Return', true)}
          {header('contribution', 'Contribution', true)}
        </tr>
      </TableHead>
      <TableBody>
        {sorted.map((row) => (
          <TableRow
            key={row.symbol}
            data-testid={`holding-${row.symbol}`}
            className="hover:bg-foreground/[0.04]"
          >
            <TableCell className="py-1.5 pr-2">
              <span className="font-mono text-xs">{row.symbol}</span>
              {row.name && (
                <span className="ml-2 truncate text-micro text-muted-foreground">
                  {row.name}
                </span>
              )}
            </TableCell>
            <TableCell className="py-1.5 pr-2 font-mono text-micro uppercase text-muted-foreground/70">
              {row.asset_class ?? '—'}
            </TableCell>
            <TableCell className="py-1.5 pl-2 text-right">
              <div className="relative inline-block w-20">
                <div
                  className="absolute inset-y-0 right-0 rounded-sm bg-primary/25"
                  style={{ width: `${(Math.abs(row.weight ?? 0) / maxWeight) * 100}%` }}
                />
                <span className="tnum relative font-mono text-xs">
                  {row.weight == null ? '—' : `${(row.weight * 100).toFixed(1)}%`}
                </span>
              </div>
            </TableCell>
            <TableCell numeric className={cn('py-1.5 pl-2 text-xs',
              (row.total_return ?? 0) > 0 ? 'text-primary'
                : (row.total_return ?? 0) < 0 ? 'text-clay' : '')}>
              {formatPercent(row.total_return)}
            </TableCell>
            <TableCell numeric className={cn('py-1.5 pl-2 text-xs',
              (row.contribution ?? 0) > 0 ? 'text-primary'
                : (row.contribution ?? 0) < 0 ? 'text-clay' : '')}>
              {formatPercent(row.contribution)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
