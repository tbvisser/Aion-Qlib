/**
 * Stage 07 — what trading takes off the top.
 *
 * The round-trip line exists because the two legs are configured and read
 * separately, so the number that decides whether a strategy survives its own
 * turnover was never on screen.
 */
import { X } from 'lucide-react'

import { BpsInput, Field, NumberInput, Section } from '@/components/builder/FormControls'
import { Badge } from '@/components/ui/badge'
import { roundTripBps } from '@/lib/bps'
import type { InspectorProps } from './types'

export function CostsInspector({ spec, setSpec }: InspectorProps) {
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

      {/* Not editable, but no longer invisible. A template or the assistant can
          carry a limit in, and until now only the run summary ever reported it
          — so the first anyone knew was after four minutes of compute. */}
      {spec.limit_threshold !== null && (
        <Field label="Price limit" hint="Carried in with this strategy, not set here">
          <div className="flex items-center gap-2">
            <Badge variant="clay">{spec.limit_threshold}</Badge>
            <button
              type="button"
              onClick={() => setSpec((prev) => ({ ...prev, limit_threshold: null }))}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          </div>
        </Field>
      )}
    </Section>
  )
}
