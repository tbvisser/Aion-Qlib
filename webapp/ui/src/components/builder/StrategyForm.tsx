/**
 * The Strategy Builder's form mode: the whole spec as labelled controls.
 *
 * A pure lift out of StrategyBuilderPage when the canvas arrived. Every effect
 * and both handlers stayed on the page, so the mode toggle changes only what is
 * rendered and never where state lives -- which is what keeps the debounced,
 * server-rendered YAML preview working identically in both modes.
 */
import { RefreshDataDialog } from '@/components/RefreshDataDialog'
import { BpsInput, Choice, DateInput, Field, NumberInput, Section } from './FormControls'
import { LearnerLine } from './LearnerLine'
import { UniversePicker } from './UniversePicker'
import { roundTripBps } from '@/lib/bps'
import type { DataStore, ModelsResponse, StrategySpec } from '@/lib/api'

interface Props {
  spec: StrategySpec
  setSpec: React.Dispatch<React.SetStateAction<StrategySpec>>
  models: ModelsResponse | null
  stores: DataStore[]
  store?: DataStore
  universes: string[]
  /** Re-fetch the stores after an ingest builds one. */
  onStoresChanged?: () => void
}

export function StrategyForm({
  spec, setSpec, models, stores, store, universes, onStoresChanged,
}: Props) {
  const set = <K extends keyof StrategySpec>(key: K, value: StrategySpec[K]) =>
    setSpec((prev) => ({ ...prev, [key]: value }))

  return (
    <div className="space-y-6">
      {/* No Name field here. The page header's input is the one rename control,
          it works in canvas mode too, and it carries the `strategy-name`
          testid — two controls editing one value is just a way to disagree. */}
      <Section title="Definition">
        {/* The learner is one line spanning the grid rather than the first two
            fields in it. Which model to use is ML Studio's question, asked
            across several at once; here it is a setting with a default, and
            both controls are still one click inside Change. */}
        <LearnerLine spec={spec} setSpec={setSpec} models={models} className="sm:col-span-2" />
        <Field label="Data store">
          <Choice
            value={spec.data_store}
            onChange={(v) => {
              // A store change invalidates the universe, the benchmark and the
              // end date together: the two stores hold different instruments
              // under different calendars, and SPY is not in the crypto store.
              const next = stores.find((s) => s.key === v)
              const list = (next?.universes ?? []).filter((u) => u !== 'benchmarks')
              const marks = next?.benchmarks ?? []
              setSpec((prev) => ({
                ...prev,
                data_store: v as StrategySpec['data_store'],
                universe: list.includes(prev.universe) ? prev.universe : (list[0] ?? ''),
                // Only reassign when the new store offers something. A store
                // with no benchmarks file keeps whatever is set, and the
                // backend's `unknown_benchmark` check reports it.
                benchmark: marks.length && !marks.includes(prev.benchmark)
                  ? marks[0] : prev.benchmark,
                test_end: next?.calendar_end ?? prev.test_end,
              }))
            }}
            options={(stores.length ? stores : []).map((s) => ({
              value: s.key,
              label: s.exists ? s.label : `${s.label} (not built)`,
            }))}
          />
          {store && store.exists && (
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
              {store.note} {store.calendar_days.toLocaleString()} trading days.
            </p>
          )}
          {/* An unbuilt store used to be a cul-de-sac: the option said
              "(not built)", nothing said what to do about it, and Run came back
              with a 503 from a layer the user never sees. The ingest dialog
              that fixes it already existed and was imported by nothing. */}
          {store && !store.exists && (
            <div className="mt-2 space-y-2">
              <p className="text-[11px] leading-relaxed text-clay">
                This store has no data yet, so a backtest against it cannot start.
                Build it from EODHD first.
              </p>
              <RefreshDataDialog onFinished={onStoresChanged} />
            </div>
          )}
        </Field>
        <Field label="Universe" hint="The names this strategy may hold">
          <UniversePicker
            value={spec.universe}
            onChange={(v) => set('universe', v)}
            store={spec.data_store}
            universes={universes}
          />
        </Field>
        <Field label="Benchmark">
          {/* The store's own benchmarks file, not a hardcoded pair — plus
              whatever the spec already holds, because a crypto template arrives
              with BTC-USD and a select that cannot represent its value renders
              blank: a required field looking unset when it is not. */}
          <Choice
            value={spec.benchmark}
            onChange={(v) => set('benchmark', v)}
            options={[...new Set([...(store?.benchmarks ?? []), spec.benchmark])]
              .filter(Boolean)
              .map((b) => ({ value: b, label: b }))}
          />
          {store && store.benchmarks.length === 0 && (
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
              This store ships no benchmark list. Any symbol it holds will do.
            </p>
          )}
        </Field>
      </Section>

      <Section
        title="Periods"
        note="Validation must start after training ends, and test after validation — otherwise the model is scored on data it has already seen."
      >
        <Field label="Train from"><DateInput value={spec.train_start} onChange={(v) => set('train_start', v)} /></Field>
        <Field label="Train to"><DateInput value={spec.train_end} onChange={(v) => set('train_end', v)} /></Field>
        <Field label="Validate from"><DateInput value={spec.valid_start} onChange={(v) => set('valid_start', v)} /></Field>
        <Field label="Validate to"><DateInput value={spec.valid_end} onChange={(v) => set('valid_end', v)} /></Field>
        <Field label="Test from"><DateInput value={spec.test_start} onChange={(v) => set('test_start', v)} /></Field>
        <Field label="Test to"><DateInput value={spec.test_end} onChange={(v) => set('test_end', v)} /></Field>
      </Section>

      <Section title="Portfolio">
        <Field label="Top K" hint="Positions held">
          <NumberInput value={spec.topk} onChange={(v) => set('topk', v)} min={1} max={500} />
        </Field>
        <Field label="Drop" hint="Replaced per rebalance">
          <NumberInput value={spec.n_drop} onChange={(v) => set('n_drop', v)} min={0} max={100} />
        </Field>
        <Field label="Open cost" hint="Basis points of notional">
          <BpsInput value={spec.open_cost} onChange={(v) => set('open_cost', v)} />
        </Field>
        <Field label="Close cost" hint="Basis points of notional">
          <BpsInput value={spec.close_cost} onChange={(v) => set('close_cost', v)} />
        </Field>
        {/* The two legs are set apart and read apart, so the number that
            actually decides whether a strategy survives its own turnover was
            never on screen. */}
        <p className="sm:col-span-2 -mt-2 text-[11px] text-muted-foreground">
          {roundTripBps(spec.open_cost, spec.close_cost)} bps round trip, every time a
          position is replaced.
        </p>
        {/* Both stores are USD-quoted — EODHD `.US` tickers and `*-USD` crypto
            pairs — and a store carries no currency field, so naming it here is
            honest without inventing one. */}
        <Field label="Min cost" hint="USD per trade, whatever the fill size">
          <NumberInput value={spec.min_cost} onChange={(v) => set('min_cost', v)} step={1} />
        </Field>
        <Field label="Account" hint="Starting capital, USD">
          <NumberInput value={spec.account} onChange={(v) => set('account', v)} step={1000000} />
        </Field>
        {/* `limit_threshold` is deliberately absent. It is a China price-limit
            concept (strategies.py `limit_threshold`) and both stores are
            US/crypto; `build_workflow_config` omits it entirely when null. A
            spec that carries one — from a template or the assistant — is
            reported by the run summary instead, so it is never silent. */}
      </Section>

      {/* Saved strategies used to be a card here. They live in the rail now,
          beside the templates and the fund book — one list answering one
          question, and visible in canvas mode too, which this never was. */}
    </div>
  )
}
