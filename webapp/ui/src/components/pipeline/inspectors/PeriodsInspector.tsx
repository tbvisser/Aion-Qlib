/**
 * Stage 04 — train, validate, test.
 *
 * Between Features and Learner because that is where qlib applies the split:
 * `fit_start_time`/`fit_end_time` land on the handler's processors, so the
 * windows shape the data before the model ever sees it.
 *
 * `PeriodTimeline` renders directly under the six dates. It used to be in a
 * different column from them, which is the wrong place for a picture whose job
 * is to show whether they are ordered sensibly.
 */
import { DateInput, Field, Section } from '@/components/builder/FormControls'
import { PeriodTimeline } from '@/components/builder/PeriodTimeline'
import type { StrategySpec } from '@/lib/api'
import type { InspectorProps } from './types'

const WINDOWS: { key: keyof StrategySpec; label: string }[] = [
  { key: 'train_start', label: 'Train from' },
  { key: 'train_end', label: 'Train to' },
  { key: 'valid_start', label: 'Validate from' },
  { key: 'valid_end', label: 'Validate to' },
  { key: 'test_start', label: 'Test from' },
  { key: 'test_end', label: 'Test to' },
]

export function PeriodsInspector({ spec, setSpec, explain }: InspectorProps) {
  const clamped = explain?.effective_test_end && explain.effective_test_end !== spec.test_end

  return (
    <Section
      title="Periods"
      columns={1}
      note="Validation must start after training ends, and test after validation — otherwise the model is scored on data it has already seen."
    >
      <PeriodTimeline spec={spec} explain={explain} />

      {WINDOWS.map(({ key, label }) => (
        <Field key={key} label={label}>
          <DateInput
            value={spec[key] as string}
            onChange={(v) => setSpec((prev) => ({ ...prev, [key]: v }))}
          />
        </Field>
      ))}

      {/* The clamp is applied by `build_workflow_config` whether or not anyone
          is told, and a backtest that quietly stops before the date on the form
          is the kind of difference that gets attributed to the strategy. */}
      {clamped && (
        <p className="text-[11px] leading-relaxed text-clay">
          This store can only be backtested to {explain?.effective_test_end}; the run will end
          there rather than on {spec.test_end}.
        </p>
      )}
    </Section>
  )
}
