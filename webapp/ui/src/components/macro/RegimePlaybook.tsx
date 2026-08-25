import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { MacroPlaybookResponse, PlaybookLens } from '@/lib/api'
import { formatIsoDate, formatPercent, toneFor } from '@/lib/macroFormat'
import { playbookMatrix } from '@/lib/playbook'
import { cn } from '@/lib/utils'

const LENSES = [
  { value: 'quadrant', label: 'Quadrant' },
  { value: 'rate_cycle', label: 'Rate cycle' },
  { value: 'risk', label: 'Risk' },
  { value: 'market', label: 'Market' },
] as const

/**
 * What each asset has actually paid in each state of a lens.
 *
 * States are rows and assets are columns: five states by eight assets is
 * thirty cells one way and thirty rows the other. Row order is fixed by the
 * lens, never by return — a table that reorders when you switch lens is
 * unreadable, and sorting by return invites reading it as a ranking.
 *
 * Every cell carries its sample size, and a thin cell is marked on two
 * **non-hue** channels: it drops out of the primary/clay verdict colour
 * entirely, and it gains a dotted underline. The number is still shown —
 * hiding it would be a different kind of lie.
 */
export function RegimePlaybook({ playbook, lens, onLensChange, loading }: {
  playbook: MacroPlaybookResponse | null
  lens: PlaybookLens
  onLensChange: (lens: PlaybookLens) => void
  loading: boolean
}) {
  const matrix = playbookMatrix(playbook)

  return (
    <Panel
      title="Regime → asset playbook"
      hint={playbook?.window
        ? `${formatIsoDate(playbook.window.start)} → ${formatIsoDate(playbook.window.end)}`
        : undefined}
      loading={loading}
      flush
      actions={
        <Segmented
          value={lens}
          options={LENSES}
          onChange={(v) => onLensChange(v as PlaybookLens)}
          size="sm"
        />
      }
    >
      {!playbook ? (
        <div className="h-64" />
      ) : !playbook.available || matrix.rows.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">
          {playbook.reason ?? 'Nothing in this window could be classified.'}
        </p>
      ) : (
        <>
          <Table>
            <TableHead>
              <tr>
                <TableHeader className="sticky left-0 z-10 bg-card">State</TableHeader>
                <TableHeader numeric>Days</TableHeader>
                {/* title preserved via tooltip — TableHeader doesn't accept title; kept raw */}
                <th
                  className="border-b border-border/50 py-2 pr-4 text-micro font-normal uppercase tracking-wider text-muted-foreground/70 text-right"
                  title="Contiguous episodes — the honest denominator"
                >
                  Epi
                </th>
                {matrix.assets.map((asset) => (
                  <TableHeader key={asset.key} numeric>
                    {asset.label}
                  </TableHeader>
                ))}
              </tr>
            </TableHead>
            <TableBody>
              {matrix.rows.map((row) => (
                <TableRow
                  key={row.state}
                  className={cn(
                    'align-top',
                    row.current && 'bg-foreground/[0.07]',
                  )}
                >
                    <td
                      className={cn('sticky left-0 z-10 px-3 py-2',
                        row.current ? 'bg-[hsl(var(--card))]' : 'bg-card')}
                      title={row.runsTitle}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', row.tone.dot)} />
                        <span className="whitespace-nowrap text-xs">{row.label}</span>
                        {row.current && (
                          <span className="font-mono text-tiny uppercase text-muted-foreground">
                            ◄ now
                          </span>
                        )}
                      </div>
                      {/* Same share-bar idiom as the regime attribution grid. */}
                      <div className="mt-1 h-0.5 w-24 rounded-full bg-foreground/10">
                        <div
                          className="h-0.5 rounded-full bg-foreground/25"
                          style={{ width: `${(row.share * 100).toFixed(1)}%` }}
                        />
                      </div>
                    </td>
                    <td className="tnum px-2 py-2 text-right font-mono text-label text-muted-foreground">
                      {row.days.toLocaleString()}
                    </td>
                    <td className="tnum px-2 py-2 text-right font-mono text-label text-muted-foreground">
                      {row.episodes}
                    </td>
                    {row.cells.map((cell, i) => (
                      <td
                        key={matrix.assets[i]?.key ?? i}
                        data-testid={`macro-playbook-cell-${row.state}-${matrix.assets[i]?.key}`}
                        className="px-2 py-2 text-right"
                        title={cell?.reason ?? undefined}
                      >
                        {!cell || cell.ann_return == null ? (
                          <span className="tnum font-mono text-xs text-muted-foreground">—</span>
                        ) : (
                          <>
                            <span className={cn(
                              'tnum block font-mono text-xs',
                              cell.thin
                                ? 'text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2'
                                : toneFor(cell.ann_return),
                            )}>
                              {formatPercent(cell.ann_return, 1)}
                            </span>
                            <span className="tnum block font-mono text-micro text-muted-foreground/70">
                              {cell.hit_rate == null ? '—' : `${(cell.hit_rate * 100).toFixed(0)}%`}
                            </span>
                            <span className="tnum block font-mono text-micro text-muted-foreground/50">
                              n={cell.n.toLocaleString()}
                            </span>
                          </>
                        )}
                      </td>
                    ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="space-y-2 border-t border-border/50 p-3">
            <div className="rounded-lg border border-clay/40 bg-clay/5 p-3 text-xs">
              {playbook.caveat}
            </div>
            <p className="font-mono text-micro leading-relaxed text-muted-foreground/70">
              Annualised from each state's own days — not a contiguous period, so
              no drawdown is reported. Second line is the hit rate, third the
              sample. Dotted and greyed means too few episodes to read as a
              result; the number is shown, not withheld.
              {playbook.unclassified > 0 &&
                ` ${playbook.unclassified.toLocaleString()} days fall outside the lens's coverage.`}
            </p>
            {playbook.warnings.map((w) => (
              <p key={w} className="font-mono text-micro text-clay">{w}</p>
            ))}
          </div>
        </>
      )}
    </Panel>
  )
}
