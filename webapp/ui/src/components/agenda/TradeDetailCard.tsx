import { Link } from 'react-router-dom'
import { MicroLabel } from '@/components/ui/micro-label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'

import type { AgendaEntry, AgendaPayload } from '@/lib/agenda'
import { cn } from '@/lib/utils'

type TradePayload = Extract<AgendaPayload, { kind: 'signal' } | { kind: 'rebalance' }>

/**
 * The trade side of the desk, honestly: model scores and rebalance turnover
 * are what this backend actually has — no fills, quantities or PnL exist
 * here, so none are implied. Broker fills stay a follow-up feed.
 *
 * Renders as a bare block, not a card: `EntryList` opens it inside the row's
 * own sub-panel, and a card nested in that would be a border inside a border
 * inside a panel.
 */
export function TradeDetailCard({ entry, payload }: {
  entry: AgendaEntry
  payload: TradePayload
}) {
  return (
    <div className="space-y-3">
      <div>
        <h4 className="min-w-0 truncate text-sm font-medium">
          {entry.href ? (
            <Link to={entry.href} className="transition-colors hover:text-primary">
              {entry.title}
            </Link>
          ) : (
            entry.title
          )}
        </h4>
        <MicroLabel as="div" className="mt-0.5">
          {payload.kind === 'signal' ? 'model signals' : 'rebalance'} · {entry.date}
        </MicroLabel>
      </div>

      <div className="border-t border-border/40 pt-3">
        {payload.kind === 'signal' ? (
          <SignalBody payload={payload} />
        ) : (
          <RebalanceBody entry={entry} payload={payload} />
        )}
      </div>
    </div>
  )
}

function SignalBody({ payload }: { payload: Extract<TradePayload, { kind: 'signal' }> }) {
  if (payload.signal.top.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No ranked instruments for this run.</p>
    )
  }
  return (
    <div>
      <Table className="font-mono text-label">
        <TableHead>
          <tr>
            <TableHeader>instrument</TableHeader>
            <TableHeader numeric>model score</TableHeader>
          </tr>
        </TableHead>
        <TableBody>
          {payload.signal.top.map((pick) => (
            <TableRow key={pick.instrument}>
              <TableCell className="text-foreground/90">{pick.instrument}</TableCell>
              <TableCell
                numeric
                className={cn(
                  pick.score == null ? 'text-muted-foreground/60'
                    : pick.score > 0 ? 'text-primary'
                      : pick.score < 0 ? 'text-clay' : 'text-muted-foreground',
                )}
              >
                {pick.score == null ? '—' : pick.score.toFixed(4)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-1.5 font-mono text-micro text-muted-foreground/50">
        prediction scores, not positions or fills
      </p>
    </div>
  )
}

function RebalanceBody({ entry, payload }: {
  entry: AgendaEntry
  payload: Extract<TradePayload, { kind: 'rebalance' }>
}) {
  return (
    <div>
      <div className="flex items-baseline gap-4 font-mono">
        <span className="flex flex-col">
          <span className="text-micro uppercase tracking-wider text-muted-foreground/60">
            turnover
          </span>
          <span className="tnum text-base">
            {payload.turnover == null ? '—' : `${(payload.turnover * 100).toFixed(1)}%`}
          </span>
        </span>
      </div>
      {entry.detail && (
        <p className="mt-1.5 text-xs text-muted-foreground">{entry.detail}</p>
      )}
    </div>
  )
}
