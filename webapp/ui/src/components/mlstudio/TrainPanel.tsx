/**
 * Train a saved strategy against several learners at once.
 *
 * This is what makes ML Studio a studio rather than a leaderboard. The Builder
 * answers "what should this trade?" and runs one backtest to check; this
 * answers "which learner should trade it?", which is a question about a
 * strategy that already exists and is the wrong shape for a form where every
 * field is a single value.
 *
 * A sweep is N ordinary `POST /runs` calls — one per model × feature-set pair,
 * each carrying the saved strategy's id. There is no batch endpoint and there
 * should not be one: every combination becomes a normal run, so the dock, the
 * ledger, the report and the compare modal all work on it without knowing a
 * sweep happened.
 *
 * **They queue.** `MAX_CONCURRENT_RUNS` is 1, so eight combinations is eight
 * runs one after another, and the server labels the waiting ones "Waiting for
 * the running backtest". The panel says so before you press the button; a UI
 * implying parallelism here would be contradicted by its own status text within
 * seconds.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Layers, Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  api, type ModelsResponse, type Run, type StoredStrategy, type StrategyCoverage,
} from '@/lib/api'
import { coverageLine } from '@/lib/coverageLine'
import { formatDuration, medianDuration } from '@/lib/runDuration'
import { cn } from '@/lib/utils'

/**
 * The most combinations one press may launch.
 *
 * Not a technical limit — it is the point past which the honest estimate stops
 * being something anyone would agree to. One run at a time times a typical
 * backtest already puts eight over an hour.
 */
export const MAX_SWEEP = 8

interface Combination {
  model: string
  handler: string
  coverage?: StrategyCoverage
}

export function TrainPanel({ runs, onLaunched }: {
  /** Every run, for the duration estimate. */
  runs: readonly Run[]
  /** Re-read the run list, so the launched runs appear without a reload. */
  onLaunched: () => void
}) {
  const [strategies, setStrategies] = useState<StoredStrategy[] | null>(null)
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [strategyId, setStrategyId] = useState('')
  const [pickedModels, setPickedModels] = useState<string[]>([])
  const [pickedHandlers, setPickedHandlers] = useState<string[]>([])
  const [coverage, setCoverage] = useState<Record<string, StrategyCoverage>>({})
  const [launching, setLaunching] = useState(false)
  const [failures, setFailures] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [list, catalog] = await Promise.all([
        api.listStrategies().catch(() => ({ strategies: [] as StoredStrategy[] })),
        api.models().catch(() => null),
      ])
      if (cancelled) return
      setStrategies(list.strategies)
      setModels(catalog)
      // Seed from the strategy itself, so the panel opens describing what that
      // strategy already is and one extra tick is a comparison.
      const first = list.strategies[0]
      if (first) {
        setStrategyId(first.id)
        setPickedModels([first.model])
        setPickedHandlers([first.handler])
      }
    })()
    return () => { cancelled = true }
  }, [])

  const strategy = strategies?.find((s) => s.id === strategyId)
  const combinations: Combination[] = pickedModels.flatMap(
    (model) => pickedHandlers.map((handler) => ({ model, handler })))
  const overCap = combinations.length > MAX_SWEEP

  /**
   * Ask the server what each combination would actually train on.
   *
   * `coverage_report` is the same check the builder's preview runs — cheap
   * (YAML rendering plus a cached census read, no qlib call) and the one thing
   * worth knowing before committing an hour: Alpha360 with a linear model is
   * exactly the pairing whose sixty VWAP columns used to empty the training
   * set, and a sweep is the first surface that produces such pairings by
   * default rather than by mistake.
   */
  useEffect(() => {
    if (!strategy || overCap || !combinations.length) return
    let cancelled = false

    void (async () => {
      for (const { model, handler } of combinations) {
        const key = `${model}::${handler}`
        if (cancelled || coverage[key]) continue
        try {
          const preview = await api.previewStrategy({ ...strategy, model, handler })
          if (cancelled || !preview.coverage) continue
          setCoverage((prev) => ({ ...prev, [key]: preview.coverage! }))
        } catch {
          /* A combination the server refuses to preview still gets a run and a
             real error; a missing advisory line must not block the sweep. */
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId, pickedModels.join(','), pickedHandlers.join(','), overCap])

  const typical = medianDuration(runs)

  const launch = async () => {
    if (!strategy || overCap) return
    setLaunching(true)
    setFailures([])
    const failed: string[] = []

    // Sequential on purpose. They queue on the server anyway, and issuing them
    // in order means the run list reads in the order they were ticked.
    for (const { model, handler } of combinations) {
      try {
        await api.startRun(
          { ...strategy, model, handler, name: `${strategy.name} · ${model}/${handler}` },
          strategy.id,
        )
      } catch (e) {
        // Named, not swallowed: a sweep where three of four started and the
        // fourth vanished is worse than one that says which one and why.
        failed.push(`${model}/${handler} — ${e instanceof Error ? e.message : 'refused'}`)
      }
    }

    setFailures(failed)
    setLaunching(false)
    onLaunched()
  }

  if (strategies && strategies.length === 0) {
    return (
      <Panel title="Train" hint="a saved strategy, against several learners">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Nothing saved yet. This page trains strategies that already exist —{' '}
          <Link to="/lab/builder" className="text-primary hover:underline">
            build and save one first
          </Link>
          , then come back to try it against several models.
        </p>
      </Panel>
    )
  }

  return (
    <Panel
      data-testid="train-panel"
      title="Train"
      hint="a saved strategy, against several learners"
      loading={!strategies || !models}
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Labelled label="Strategy">
            <Select value={strategyId} onValueChange={setStrategyId}>
              <SelectTrigger className="text-xs" data-testid="train-strategy">
                <SelectValue placeholder="Pick a saved strategy" />
              </SelectTrigger>
              <SelectContent>
                {(strategies ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id} className="text-xs">
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {strategy && (
              <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                {strategy.universe} · {strategy.data_store} · {strategy.test_start} → {strategy.test_end}
              </p>
            )}
          </Labelled>

          <Labelled label="Everything else stays put">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The universe, the windows, the portfolio rules and the costs come from the saved
              strategy and are identical across every run — which is what makes the results
              comparable. Change those in the Builder.
            </p>
          </Labelled>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TickList
            label="Models"
            options={(models?.models ?? []).map((m) => ({ value: m.id, label: m.label }))}
            picked={pickedModels}
            onChange={setPickedModels}
            testId="train-model"
          />
          <TickList
            label="Feature sets"
            options={(models?.handlers ?? []).map((h) => ({ value: h, label: h }))}
            picked={pickedHandlers}
            onChange={setPickedHandlers}
            testId="train-handler"
          />
        </div>

        {combinations.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-border/50 p-2.5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              {combinations.length} {combinations.length === 1 ? 'run' : 'runs'}
            </div>
            {combinations.map(({ model, handler }) => {
              const found = coverage[`${model}::${handler}`]
              return (
                <div key={`${model}::${handler}`} className="flex items-baseline gap-2 text-[11px]">
                  <span className="w-40 shrink-0 truncate font-mono">{model} / {handler}</span>
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    {coverageLine(found)}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {/* The queue is the server's, and it labels the waiting runs. Saying
                so here means the phase text confirms the panel rather than
                contradicting it. */}
            Runs go one at a time — the rest wait in the queue.
            {typical != null && combinations.length > 0 && !overCap && (
              <> About {formatDuration(typical * combinations.length)} in total,
                {' '}based on how long recent runs took.</>
            )}
            {typical == null && ' No finished runs yet, so there is no estimate.'}
          </p>

          <Button
            size="sm"
            onClick={() => void launch()}
            disabled={launching || !strategy || !combinations.length || overCap}
            data-testid="train-launch"
            title={overCap
              ? `${combinations.length} combinations — untick some, at most ${MAX_SWEEP} at a time`
              : !combinations.length
                ? 'Tick at least one model and one feature set'
                : `Queue ${combinations.length} runs`}
          >
            {launching ? <Layers className="h-4 w-4 animate-pulse" /> : <Play className="h-4 w-4" />}
            {launching ? 'Queueing…' : `Train ${combinations.length || ''}`.trim()}
          </Button>
        </div>

        {overCap && (
          <p className="text-[11px] leading-relaxed text-clay">
            {combinations.length} combinations is more than {MAX_SWEEP}. They run one after
            another, so that is a long wait for results you cannot look at until the end —
            untick a few and sweep again afterwards.
          </p>
        )}

        {failures.length > 0 && (
          <div className="space-y-0.5 rounded-lg border border-destructive/40 p-2.5">
            <div className="font-mono text-[10px] uppercase tracking-wider text-destructive">
              {failures.length} did not start
            </div>
            {failures.map((f) => (
              <p key={f} className="font-mono text-[11px] text-destructive">{f}</p>
            ))}
          </div>
        )}
      </div>
    </Panel>
  )
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
      {children}
    </div>
  )
}

/**
 * A set of ticks, with the last one held down.
 *
 * Unticking everything would make the sweep empty and the button dead for a
 * reason nobody could see, so the final selection refuses with the reason in
 * its `title` — `aria-disabled` rather than `disabled`, because a disabled
 * control swallows hover and the tooltip is where the reason lives.
 */
function TickList({ label, options, picked, onChange, testId }: {
  label: string
  options: { value: string; label: string }[]
  picked: string[]
  onChange: (next: string[]) => void
  testId: string
}) {
  const last = (value: string) => picked.length === 1 && picked[0] === value

  return (
    <Labelled label={label}>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const on = picked.includes(option.value)
          const held = on && last(option.value)
          return (
            <button
              key={option.value}
              type="button"
              data-testid={`${testId}-${option.value}`}
              aria-pressed={on}
              aria-disabled={held}
              title={held ? 'At least one is needed' : undefined}
              onClick={() => {
                if (held) return
                onChange(on ? picked.filter((v) => v !== option.value)
                  : [...picked, option.value])
              }}
              className={cn(
                'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                on ? 'border-primary/50 bg-primary/10' : 'border-border/50 hover:bg-foreground/[0.04]',
                held && 'cursor-not-allowed',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </Labelled>
  )
}
