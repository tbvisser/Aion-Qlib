/**
 * Stage 07 — how the signal becomes positions.
 *
 * `TopkDropoutStrategy`: hold the top K by score, replace the worst N each
 * rebalance. Both bounds match the Pydantic constraints so an out-of-range
 * value is refused here rather than at launch.
 */
import { NumberInput, Section } from '@/components/builder/FormControls'
import { CompatField, fieldBounds } from './compat'
import type { InspectorProps } from './types'

export function PortfolioInspector(props: InspectorProps) {
  const { spec, setSpec } = props
  // Read off the Pydantic field rather than retyped. The literals stay as the
  // fallback for an older server, but two hand-kept copies of a bound is how a
  // form comes to accept a value the model then 422s.
  const topk = fieldBounds(props, 'topk')
  const drop = fieldBounds(props, 'n_drop')

  return (
    <Section title="Portfolio" columns={1}>
      <CompatField field="topk" label="Top K" hint="Positions held" ctx={props}>
        <NumberInput
          value={spec.topk}
          onChange={(topk_) => setSpec((prev) => ({ ...prev, topk: topk_ }))}
          min={topk?.min ?? 1}
          max={(topk?.max as number | undefined) ?? 500}
        />
      </CompatField>
      <CompatField field="n_drop" label="Drop" hint="Replaced per rebalance" ctx={props}>
        <NumberInput
          value={spec.n_drop}
          onChange={(n_drop) => setSpec((prev) => ({ ...prev, n_drop }))}
          min={drop?.min ?? 0}
          max={(drop?.max as number | undefined) ?? 100}
        />
      </CompatField>
    </Section>
  )
}
