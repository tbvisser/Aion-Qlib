import type { ReactNode } from 'react'

import { MicroLabel } from '@/components/ui/micro-label'
import { cn } from '@/lib/utils'

/**
 * The house table.
 *
 * Nineteen files hand-rolled `<table>` and between them grew 25+ distinct
 * header-cell class strings — `py-2 pr-4 font-medium` here, a 9px mono
 * uppercase at `px-3 py-1.5` there, and plain headers beside mono ones in
 * the same row. One header cell style, stated once: the micro
 * label over `py-2 pr-4`, numeric columns right-aligned with tabular figures.
 *
 * Two layers. The styled primitives below are for tables with structure of
 * their own (grouped rows, matrices, inline editors). `DataTable` is the thin
 * column-spec wrapper for the common case — a flat listing — sharing the
 * `Column<T>` contract that `CatalogBrowser` established.
 */

export function Table({
  className,
  containerClassName,
  children,
  'data-testid': testId,
}: {
  className?: string
  /** The scroll wrapper's classes — width caps, flush-bleed margins. */
  containerClassName?: string
  children: ReactNode
  'data-testid'?: string
}) {
  return (
    <div className={cn('overflow-x-auto', containerClassName)}>
      <table data-testid={testId} className={cn('w-full border-collapse text-left text-caption', className)}>
        {children}
      </table>
    </div>
  )
}

export function TableHead({ className, children }: { className?: string; children: ReactNode }) {
  return <thead className={className}>{children}</thead>
}

export function TableBody({ className, children }: { className?: string; children: ReactNode }) {
  return <tbody className={className}>{children}</tbody>
}

export function TableRow({
  className,
  onClick,
  'data-testid': testId,
  children,
}: {
  className?: string
  onClick?: () => void
  'data-testid'?: string
  children: ReactNode
}) {
  return (
    <tr
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'border-b border-border/30 last:border-b-0',
        onClick && 'cursor-pointer transition-colors hover:bg-foreground/[0.02]',
        className,
      )}
    >
      {children}
    </tr>
  )
}

/** A header cell: the micro label, `th`-shaped. */
export function TableHeader({
  className,
  numeric,
  children,
}: {
  className?: string
  /** Right-aligned, for a column of numbers. */
  numeric?: boolean
  children?: ReactNode
}) {
  return (
    <MicroLabel
      as="th"
      className={cn(
        'border-b border-border/50 py-2 pr-4 font-normal',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </MicroLabel>
  )
}

export function TableCell({
  className,
  numeric,
  colSpan,
  children,
}: {
  className?: string
  /** Right-aligned tabular figures, matching a `numeric` header. */
  numeric?: boolean
  colSpan?: number
  children?: ReactNode
}) {
  return (
    <td colSpan={colSpan} className={cn('py-2 pr-4', numeric && 'tnum text-right font-mono', className)}>
      {children}
    </td>
  )
}

/**
 * The shared column contract. Moved here from `CatalogBrowser` (which
 * re-exports it) so a plain listing does not need the catalog's facet shell
 * to describe its columns.
 */
export interface Column<T> {
  key: string
  label: string
  /** Tailwind width class. Omit for a flexible column. */
  width?: string
  render: (row: T) => ReactNode
  /** Right-aligned, for numbers. */
  numeric?: boolean
}

/** The flat-listing case: columns in, rows out, nothing bespoke. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  className,
  containerClassName,
  'data-testid': testId,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  /** Rendered in place of the body when there are no rows. */
  empty?: ReactNode
  className?: string
  containerClassName?: string
  'data-testid'?: string
}) {
  if (rows.length === 0 && empty) return <>{empty}</>
  return (
    <Table className={className} containerClassName={containerClassName} data-testid={testId}>
      <TableHead>
        <tr>
          {columns.map((col) => (
            <TableHeader key={col.key} numeric={col.numeric} className={col.width}>
              {col.label}
            </TableHeader>
          ))}
        </tr>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined}>
            {columns.map((col) => (
              <TableCell key={col.key} numeric={col.numeric}>
                {col.render(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
