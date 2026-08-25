/**
 * Stage 03 — which names the strategy may hold, and what it is measured against.
 *
 * Benchmark sits here rather than with the store because it is the same kind of
 * question — which symbols — off the same `DataStore` object, and a store
 * change invalidates both together.
 */
import { Choice, Section } from '@/components/builder/FormControls'
import { UniversePicker } from '@/components/builder/UniversePicker'
import { selectableUniverses } from '@/lib/storeSwitch'
import { CompatField, choiceOptions } from './compat'
import type { InspectorProps } from './types'

export function UniverseInspector(props: InspectorProps) {
  const { spec, setSpec, stores } = props
  const store = stores.find((s) => s.key === spec.data_store)

  return (
    <Section title="Universe" columns={1}>
      <CompatField field="universe" label="Universe"
                   hint="The names this strategy may hold" ctx={props}>
        <UniversePicker
          value={spec.universe}
          onChange={(universe) => setSpec((prev) => ({ ...prev, universe }))}
          store={spec.data_store}
          universes={selectableUniverses(store)}
        />
      </CompatField>

      {/* The store's own list plus whatever the spec already holds — a crypto
          template arrives with BTC-USD, and a select that cannot represent its
          value renders blank: a required field looking unset when it is not.
          The server now builds that union itself, and on a store shipping no
          benchmarks file it falls back to that store's curated names rather
          than to nothing. The sentence explaining as much is its `note`, which
          `CompatField` renders as the hint. */}
      <CompatField field="benchmark" label="Benchmark" ctx={props}>
        <Choice
          value={spec.benchmark}
          onChange={(benchmark) => setSpec((prev) => ({ ...prev, benchmark }))}
          options={choiceOptions(props, 'benchmark',
                                 [...new Set([...(store?.benchmarks ?? []), spec.benchmark])]
                                   .filter(Boolean))}
        />
      </CompatField>
    </Section>
  )
}
