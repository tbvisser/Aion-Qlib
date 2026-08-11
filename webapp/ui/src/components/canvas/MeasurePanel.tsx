/**
 * How well the column you just drew predicts, without waiting for a backtest.
 *
 * The canvas could compose a factor and could not produce a single number about
 * it. `POST /factors/evaluate` has always existed and was wired only to the
 * Databank and the Indicators page, so judging your own work meant leaving the
 * builder, retyping the expression somewhere else, or spending five minutes on a
 * full train-and-backtest to find out the factor was noise.
 *
 * It lives in the column inspector because IC is a property of the *column*, and
 * this is already the column's surface. The expression bar is about the string;
 * the block palette is about what you can add. Neither answers "is this any
 * good".
 *
 * **The window is the test window, not the training one.** Measuring on the
 * period the model is about to fit tells you what it will memorise, not what it
 * will predict. The window is written under the button rather than left implicit.
 */
import { useState } from 'react'
import { Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { IcChart, IcMetrics } from '@/components/factors/IcResult'
import { HORIZONS, icVerdict } from '@/components/factors/icVerdict'
import { api, type FactorEvaluation } from '@/lib/api'
import { hasHole } from '@/lib/factorExpr/serialize'

export interface MeasureContext {
  universe: string
  testStart: string
  testEnd: string
  /** The store the strategy targets. */
  store?: string
  /** The store this API process actually mounted. */
  mountedStore?: string
}

export function MeasurePanel({ expression, context }: {
  expression: string
  context: MeasureContext
}) {
  const [horizon, setHorizon] = useState<number>(5)
  const [result, setResult] = useState<FactorEvaluation | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const unfinished = !expression || hasHole(expression)
  // One `qlib.init` per API process, and it cannot be re-pointed per request —
  // so this endpoint can only ever read the mounted store. A number measured
  // against the wrong store is worse than no number.
  const wrongStore = Boolean(
    context.store && context.mountedStore && context.store !== context.mountedStore)

  const blocked = unfinished
    ? 'Finish the column first — it still has an empty slot.'
    : wrongStore
      ? `Measuring reads the store this API process mounted (${context.mountedStore}). `
        + `This strategy targets ${context.store}.`
      : null

  const measure = async () => {
    if (blocked) return
    setRunning(true)
    setError(null)
    try {
      setResult(await api.evaluateFactor({
        expression,
        universe: context.universe,
        start: context.testStart,
        end: context.testEnd,
        horizon,
      }))
    } catch (e) {
      // A refused expression is a verdict, not a crash — `ApiError` already
      // unpacks the server's sentence, so render it and keep the panel calm.
      setError(e instanceof Error ? e.message : 'Could not measure this column')
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  const verdict = result ? icVerdict(result) : null

  return (
    <Panel title="Measure" hint="before you spend a backtest on it">
      <div className="space-y-2">
        <Segmented
          size="sm"
          value={String(horizon)}
          onChange={(v) => setHorizon(Number(v))}
          options={HORIZONS.map((h) => ({
            value: String(h), label: `${h}d`,
            title: `Correlate against the ${h}-day forward return`,
          }))}
        />

        <Button
          size="sm"
          className={blocked ? 'w-full pointer-events-auto opacity-50' : 'w-full'}
          onClick={() => void measure()}
          // aria-disabled, not disabled: a disabled button swallows hover, and
          // the title is the only place the reason is written down.
          aria-disabled={Boolean(blocked)}
          disabled={running}
          title={blocked ?? 'Cross-sectional IC against the forward return'}
        >
          <Play className="h-4 w-4" />
          {running ? 'Measuring…' : 'Measure this column'}
        </Button>

        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground/70">
          {context.testStart} → {context.testEnd} · {context.universe} · {horizon}d
        </p>
        {blocked && (
          <p className="text-[11px] leading-relaxed text-clay">{blocked}</p>
        )}
        {error && (
          <p className="text-[11px] leading-relaxed text-clay">{error}</p>
        )}
      </div>

      {result && (
        <div className="mt-3 space-y-2">
          <IcMetrics result={result} compact />
          {verdict && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">{verdict}</p>
          )}
          <IcChart result={result} height={140} />
        </div>
      )}
    </Panel>
  )
}
