/**
 * Stage 07 — what trading takes off the top.
 *
 * The round-trip line exists because the two legs are configured and read
 * separately, so the number that decides whether a strategy survives its own
 * turnover was never on screen.
 */
import { useState } from 'react'

import { BpsInput, Field, NumberInput, Section } from '@/components/builder/FormControls'
import { Input } from '@/components/ui/input'
import { roundTripBps } from '@/lib/bps'
import { parseNumberField } from '@/lib/numberField'
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
        <LimitInput
          value={spec.limit_threshold}
          onChange={(limit_threshold) => setSpec((prev) => ({ ...prev, limit_threshold }))}
        />
      </CompatField>
    </Section>
  )
}

/**
 * The one nullable number on the spec. Empty is a real value — no limit — so
 * this cannot be `NumberInput`, whose empty field is an error.
 *
 * It used to render only when a template had already carried a value in, as a
 * read-only badge with a Clear button. The costs advisory on crypto stores
 * tells the reader to set this field; an advisory pointing at a control that
 * does not exist is advice that cannot be followed.
 */
function LimitInput({ value, onChange }: {
  value: number | null
  onChange: (v: number | null) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const parsed = draft === null ? null : parseNumberField(draft, { min: 0 })

  return (
    <div className="space-y-1">
      <Input
        type="number"
        value={draft ?? (value === null ? '' : value)}
        min={0}
        step={0.05}
        placeholder="No limit"
        onChange={(e) => {
          const text = e.target.value
          if (text.trim() === '') {
            setDraft(null)
            onChange(null)
            return
          }
          setDraft(text)
          const next = parseNumberField(text, { min: 0 })
          if (next.ok) onChange(next.value)
        }}
        onBlur={() => {
          if (draft !== null && parseNumberField(draft, { min: 0 }).ok) setDraft(null)
        }}
        className="tnum font-mono text-xs"
      />
      {parsed && !parsed.ok && (
        <p className="text-[11px] leading-relaxed text-clay">{parsed.error}</p>
      )}
    </div>
  )
}
