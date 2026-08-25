/**
 * Stage 08 — what trading takes off the top.
 *
 * The round-trip line exists because the two legs are configured and read
 * separately, so the number that decides whether a strategy survives its own
 * turnover was never on screen.
 */
import { BpsInput, Field, NullableNumberInput, NumberInput, Section }
  from '@/components/builder/FormControls'
import { roundTripBps } from '@/lib/bps'
import { CompatField } from './compat'
import type { InspectorProps } from './types'

export function CostsInspector(props: InspectorProps) {
  const { spec, setSpec } = props
  return (
    <Section title="Costs" columns={1}>
      <Field label="Open cost">
        <BpsInput
          value={spec.open_cost}
          onChange={(open_cost) => setSpec((prev) => ({ ...prev, open_cost }))}
        />
      </Field>
      <Field label="Close cost" hint={`${roundTripBps(spec.open_cost, spec.close_cost)} bps round trip`}>
        <BpsInput
          value={spec.close_cost}
          onChange={(close_cost) => setSpec((prev) => ({ ...prev, close_cost }))}
        />
      </Field>
      <Field label="Minimum cost" hint="Per trade, in account currency">
        <NumberInput
          value={spec.min_cost}
          onChange={(min_cost) => setSpec((prev) => ({ ...prev, min_cost }))}
          min={0}
        />
      </Field>
      <Field label="Account">
        <NumberInput
          value={spec.account}
          onChange={(account) => setSpec((prev) => ({ ...prev, account }))}
          min={1}
          step={1_000_000}
        />
      </Field>

      {/* The only field on this stage the backend has an opinion about: on a
          crypto store with no limit set, `no_price_limit` fires as an advisory.
          It reached the stage card before; putting it on the control means the
          advice and the way to follow it are in the same place. The other four
          costs fields have no server-side check, so a `CompatField` around them
          would be a wrapper with nothing to render. */}
      <CompatField
        field="limit_threshold"
        label="Price limit"
        hint="The daily move beyond which a fill is refused, as a fraction — 0.5 blocks moves over 50%. Empty means no limit."
        ctx={props}
      >
        {/* The one nullable number on the spec: empty is a real value — no
            limit — so this cannot be `NumberInput`, whose empty field is an
            error. It used to render only when a template had already carried a
            value in, as a read-only badge with a Clear button; the crypto
            costs advisory tells the reader to *set* this field, and advice
            pointing at a control that does not exist cannot be followed. */}
        <NullableNumberInput
          value={spec.limit_threshold}
          onChange={(limit_threshold) => setSpec((prev) => ({ ...prev, limit_threshold }))}
        />
      </CompatField>
    </Section>
  )
}
