import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MicroLabel } from '@/components/ui/micro-label'
import { Badge } from '@/components/ui/badge'
import { Notice } from '@/components/ui/notice'
import { Panel } from '@/components/ui/panel'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/layout/PageHeader'
import { useBrokerAccounts } from '@/hooks/useBrokerAccounts'
import { type VibeBrokerProfile, type VibeBrokerResult } from '@/lib/api'
import { cn } from '@/lib/utils'

// ── helpers ──────────────────────────────────────────────────────────────────

/** 2–3 letter chip for a connector name. */
function connectorChip(connector: string): string {
  const map: Record<string, string> = {
    ibkr: 'IB',
    alpaca: 'ALP',
    binance: 'BNB',
    okx: 'OKX',
    ccxt: 'CCX',
  }
  return map[connector.toLowerCase()] ?? connector.slice(0, 3).toUpperCase()
}

/**
 * Probe a loose VibeBrokerResult for the first array-valued key.
 * Positions / orders may live under `positions`, `orders`, `data`, `items`, etc.
 */
function firstArray(obj: VibeBrokerResult): [string, unknown[]] | null {
  const skip = new Set(['status', 'error'])
  for (const [k, v] of Object.entries(obj)) {
    if (!skip.has(k) && Array.isArray(v) && v.length > 0) return [k, v as unknown[]]
  }
  return null
}

/** Scalar fields from a VibeBrokerResult (non-array, non-status). */
function scalarEntries(obj: VibeBrokerResult): [string, string][] {
  return Object.entries(obj)
    .filter(([k, v]) => k !== 'status' && k !== 'error' && !Array.isArray(v) && v !== null && v !== undefined)
    .map(([k, v]) => [k, String(v)])
}

/** Whether a value looks like a number (possibly with sign / decimals). */
function isNumericString(s: string): boolean {
  return /^-?\d[\d,._]*$/.test(s.trim())
}

// ── sub-components ────────────────────────────────────────────────────────────

function ProfileCard({
  profile,
  selected,
  onSelect,
}: {
  profile: VibeBrokerProfile
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-2 rounded-xl border p-4 text-left transition-all',
        selected
          ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
          : 'border-border/50 bg-card hover:border-border hover:bg-foreground/[0.02]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {/* connector chip */}
        <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-label font-semibold tracking-widest text-foreground">
          {connectorChip(profile.connector)}
        </span>
        <div className="flex flex-wrap justify-end gap-1">
          <Badge
            variant={profile.environment === 'live' ? 'outline' : 'muted'}
            className={profile.environment === 'live' ? 'border-destructive/50 text-destructive/80' : ''}
          >
            {profile.environment}
          </Badge>
          {profile.readonly && <Badge variant="muted">read-only</Badge>}
          {selected && <Badge variant="primary">selected</Badge>}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium leading-tight">{profile.label}</p>
        {profile.notes && (
          <p className="mt-1 text-label leading-snug text-muted-foreground">{profile.notes}</p>
        )}
      </div>

      {profile.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {profile.capabilities.map((cap) => (
            <span
              key={cap}
              className="rounded border border-border/40 px-1 py-0.5 font-mono text-tiny text-muted-foreground/70"
            >
              {cap}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}

/** A generic table rendered from an array of flat objects. */
function LooseTable({ rows }: { rows: unknown[] }) {
  if (rows.length === 0) return <p className="p-3 text-xs text-muted-foreground">No rows.</p>

  const allKeys = Array.from(
    rows.reduce<Set<string>>((s, r) => {
      if (r && typeof r === 'object') Object.keys(r as object).forEach((k) => s.add(k))
      return s
    }, new Set()),
  )

  return (
    <Table className="min-w-max text-label">
      <TableHead>
        <tr>
          {allKeys.map((k) => (
            <TableHeader key={k} className="px-3 py-1.5">
              {k}
            </TableHeader>
          ))}
        </tr>
      </TableHead>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={i} className="hover:bg-foreground/[0.02]">
            {allKeys.map((k) => {
              const v = (row as Record<string, unknown>)[k]
              const str = v === null || v === undefined ? '—' : String(v)
              const isNum = isNumericString(str)
              return (
                <TableCell key={k} numeric={isNum} className="px-3 py-1.5">
                  {str}
                </TableCell>
              )
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Renders a scalar-map key/value card. */
function ScalarCard({ entries }: { entries: [string, string][] }) {
  if (entries.length === 0) return <p className="p-3 text-xs text-muted-foreground">No data.</p>
  return (
    <div className="grid gap-x-6 gap-y-0.5 p-3 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2 border-b border-border/20 py-1.5 last:border-0">
          <MicroLabel className="shrink-0 text-tiny">{k}</MicroLabel>
          <span className={cn('font-mono text-label', isNumericString(v) ? 'tabular-nums' : '')}>{v}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Section that independently handles ok / config-guidance / error states.
 * `status: "error"` from the broker is shown as configuration guidance (not
 * a crash banner), because the normal unconfigured state returns exactly that.
 */
function BrokerSection({
  title,
  result,
  loading,
}: {
  title: string
  result: VibeBrokerResult | null
  loading: boolean
}) {
  const array = result ? firstArray(result) : null
  const scalars = result && result.status === 'ok' && !array ? scalarEntries(result) : []

  return (
    <Panel title={title} loading={loading && !result}>
      {!result ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : result.status === 'error' ? (
        <div className="space-y-2">
          <div className="rounded border border-border/60 bg-muted/30 p-3 font-mono text-label text-muted-foreground">
            {result.error ?? 'Unknown error from broker sidecar.'}
          </div>
          <p className="text-label text-muted-foreground">
            Configure credentials in <code className="font-mono">vibe/.env</code> — see{' '}
            <code className="font-mono">vibe/README.md</code>.
          </p>
        </div>
      ) : array ? (
        <LooseTable rows={array[1]} />
      ) : scalars.length > 0 ? (
        <ScalarCard entries={scalars} />
      ) : (
        <p className="text-xs text-muted-foreground">No data returned.</p>
      )}
    </Panel>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

export function AccountsPage() {
  const { health, connections, account, positions, orders, history, error, loading, refresh, select } =
    useBrokerAccounts()

  // One header for all three render branches — repeating it per branch is how
  // its copy drifted three ways. Refresh is valid in every state (it retries).
  const header = (
    <PageHeader
      title="Broker accounts"
      description="Read-only broker connectivity via the Vibe-Trading sidecar."
      actions={
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn('mr-1 h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      }
    />
  )

  // Sidecar offline — show one card and nothing else.
  if (health?.status === 'unreachable' || error === 'unreachable') {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {header}
        <div className="p-6">
          <Notice tone="muted">
            <p>
              Vibe sidecar offline — run{' '}
              <code className="font-mono text-label">infra\stack.ps1 up</code> to
              start it.
            </p>
          </Notice>
        </div>
      </div>
    )
  }

  // Top-level error (not an unreachable sidecar, e.g. unexpected 5xx).
  if (error && error !== 'unreachable') {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {header}
        <div className="p-6">
          <Notice tone="destructive">{error}</Notice>
        </div>
      </div>
    )
  }

  const profiles = connections?.profiles ?? []
  const selectedId = connections?.selected_profile ?? null

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {header}

      <div className="space-y-6 p-6">
        {/* Profile cards row */}
        {profiles.length === 0 && !loading ? (
          <Notice tone="muted">
            No broker profiles configured. Add a profile block in{' '}
            <code className="font-mono text-label">vibe/.env</code> or{' '}
            <code className="font-mono text-label">vibe/connections.yaml</code> — see{' '}
            <code className="font-mono text-label">vibe/README.md</code>.
          </Notice>
        ) : (
          <div className={cn(
            'grid gap-3',
            profiles.length === 1 ? 'max-w-sm' :
            profiles.length === 2 ? 'grid-cols-1 sm:grid-cols-2 max-w-2xl' :
            'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
          )}>
            {profiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                selected={profile.id === selectedId}
                onSelect={() => { void select(profile.id) }}
              />
            ))}
          </div>
        )}

        {/* Data sections — shown even if status:"error" (config guidance) */}
        {(profiles.length > 0 || loading) && (
          <div className="space-y-4">
            <BrokerSection title="Account" result={account} loading={loading} />
            <BrokerSection title="Positions" result={positions} loading={loading} />
            <BrokerSection title="Open orders" result={orders} loading={loading} />
            <BrokerSection title="Trade history" result={history} loading={loading} />
          </div>
        )}

        {/* Safety footer */}
        <p className="border-t border-border/30 pt-4 font-mono text-micro text-muted-foreground/50">
          Read-only + paper. Live order placement is not wired through this app.
        </p>
      </div>
    </div>
  )
}
