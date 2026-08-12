/**
 * Stage 06 — how the signal becomes positions.
 *
 * `TopkDropoutStrategy`: hold the top K by score, replace the worst N each
 * rebalance. Both bounds match the Pydantic constraints so an out-of-range
 * value is refused here rather than at launch.
 */
import { Field, NumberInput, Section } from '@/components/builder/FormControls'
import type { InspectorProps } from './types'

export function PortfolioInspector({ spec, setSpec }: InspectorProps) {
  return (
    <Section title="Portfolio" columns={1}>
      <Field label="Top K" hint="Positions held">
        <NumberInput
          value={spec.topk}
          onChange={(topk) => setSpec((prev) => ({ ...prev, topk }))}
          min={1}
          max={500}
        />
      </Field>
      <Field label="Drop" hint="Replaced per rebalance">
        <NumberInput
          value={spec.n_drop}
          onChange={(n_drop) => setSpec((prev) => ({ ...prev, n_drop }))}
          min={0}
          max={100}
        />
      </Field>
    </Section>
  )
}
