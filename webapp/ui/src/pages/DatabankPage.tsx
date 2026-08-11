import { useEffect, useState } from 'react'
import { Play } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { ComingSoon } from '@/components/ComingSoon'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Notice } from '@/components/ui/notice'
import { IcChart, IcMetrics } from '@/components/factors/IcResult'
import { HORIZONS, icVerdict } from '@/components/factors/icVerdict'
import { api, type CatalogFactor, type FactorCatalog, type FactorEvaluation } from '@/lib/api'
import { useHealth } from '@/hooks/useHealth'
import { cn } from '@/lib/utils'

/**
 * Databank. Today it is factor evaluation — the former Factor Lab, folded into
 * the Strategy Lab destination that owns the raw material a strategy is built
 * from. The curated library, the instrument catalog and the data stores belong
 * here too; the roadmap strip at the bottom names them.
 */
export function DatabankPage() {
  const { health } = useHealth(0)
  const [catalog, setCatalog] = useState<FactorCatalog | null>(null)
  const [expression, setExpression] = useState('Ref($close,20)/$close - 1')
  const [horizon, setHorizon] = useState(5)
  const [start, setStart] = useState('2022-01-01')
  const [result, setResult] = useState<FactorEvaluation | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const universe = health?.qlib.universes?.includes('top500') ? 'top500' : 'all'
  // One sentence, from the same place the canvas and Indicators read it.
  const verdict = result ? icVerdict(result) : null

  useEffect(() => {
    api.factorCatalog().then(setCatalog).catch(() => setCatalog(null))
  }, [])

  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      setResult(await api.evaluateFactor({ expression, universe, start, horizon }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Evaluation failed')
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Databank"
        // Paired with the Indicators page next door, which browses the
        // ready-made vocabulary. This one is where you write your own.
        description="Write your own factor expression and measure how well it predicts forward returns. For the ready-made ones, see Indicators."
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Expression</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  value={expression}
                  onChange={(e) => setExpression(e.target.value)}
                  spellCheck={false}
                  rows={3}
                  className="font-mono text-sm"
                />
                <div className="flex flex-wrap items-end gap-4">
                  <label className="space-y-1">
                    <span className="block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                      From
                    </span>
                    <input
                      type="date"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                      className="h-9 rounded-lg border border-border/50 bg-background px-2 font-mono text-xs"
                    />
                  </label>
                  <div className="space-y-1">
                    <span className="block font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                      Forward horizon
                    </span>
                    <div className="flex items-center gap-1 rounded-lg border border-border/50 p-0.5">
                      {HORIZONS.map((h) => (
                        <button
                          key={h}
                          onClick={() => setHorizon(h)}
                          className={cn(
                            'rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors',
                            horizon === h
                              ? 'bg-foreground/[0.07] text-foreground'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {h}d
                        </button>
                      ))}
                    </div>
                  </div>
                  <Button onClick={() => void run()} disabled={running} className="ml-auto">
                    <Play className="h-4 w-4" />
                    {running ? 'Evaluating…' : 'Evaluate'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Cross-sectional IC against the {horizon}-day forward return over{' '}
                  <span className="font-mono">{universe}</span>, computed the same way the
                  engine reports it after a backtest.
                </p>
              </CardContent>
            </Card>

            {error && (
              <Notice tone="destructive" icon={false}>
                <span className="font-mono text-xs">{error}</span>
              </Notice>
            )}

            {result && (
              <>
                <IcMetrics result={result} />
                {verdict && (
                  <Notice tone="muted">
                    <p className="text-[13px] leading-relaxed">{verdict}</p>
                  </Notice>
                )}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Monthly mean IC</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <IcChart result={result} />
                  </CardContent>
                </Card>
              </>
            )}
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Factor library
                  {catalog && (
                    <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                      {catalog.factors.length}
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              {/* Grouped and collapsed. Rendering a hundred rows flat turned the
                  card into a page-length wall with the operators pushed off it. */}
              <CardContent className="space-y-1 p-2">
                {catalog?.families.map((family) => (
                  <details key={family.key} className="group">
                    <summary
                      title={family.description}
                      className="cursor-pointer rounded-md px-2.5 py-1.5 font-mono text-xs transition-colors hover:bg-foreground/[0.04]"
                    >
                      {family.label}
                      <span className="ml-1.5 text-[10px] text-muted-foreground">
                        {family.count}
                      </span>
                    </summary>
                    {catalog.factors
                      .filter((f) => f.family === family.key)
                      .map((f) => (
                        <CatalogRow
                          key={f.name}
                          factor={f}
                          onPick={() => setExpression(f.expression)}
                        />
                      ))}
                  </details>
                ))}
              </CardContent>
            </Card>

            {catalog && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Operators</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1">
                    {catalog.operators.map((op) => (
                      <span
                        key={op}
                        className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {op}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        <div className="mt-6">
          <ComingSoon phase="Databank">
            Today: factor evaluation. Still to fold in — the curated factor library, the instrument
            catalog, and data-store status and refresh, which currently live in a dialog reachable
            only from inside the Strategy Builder.
          </ComingSoon>
        </div>
      </div>
    </>
  )
}

function CatalogRow({ factor, onPick }: { factor: CatalogFactor; onPick: () => void }) {
  const dead = factor.runnable === false
  return (
    <button
      onClick={onPick}
      disabled={dead}
      title={[factor.note, factor.caveat].filter(Boolean).join('\n\n') || undefined}
      className={cn(
        'block w-full rounded-md px-2.5 py-2 text-left transition-colors',
        dead ? 'cursor-not-allowed opacity-40' : 'hover:bg-foreground/[0.04]',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-medium">{factor.name}</span>
        {dead ? (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
            no data
          </span>
        ) : factor.back_days != null && factor.back_days >= 60 && (
          <span
            className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
            title={`Needs ${factor.back_days} trading days of history`}
          >
            {factor.back_days}d
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{factor.summary}</p>
    </button>
  )
}
