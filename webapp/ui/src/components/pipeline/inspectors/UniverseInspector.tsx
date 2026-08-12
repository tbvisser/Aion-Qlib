/**
 * Stage 02 — which names the strategy may hold, and what it is measured against.
 *
 * Benchmark sits here rather than with the store because it is the same kind of
 * question — which symbols — off the same `DataStore` object, and a store
 * change invalidates both together.
 */
import { Choice, Field, Section } from '@/components/builder/FormControls'
import { UniversePicker } from '@/components/builder/UniversePicker'
import { selectableUniverses } from '@/lib/storeSwitch'
import type { InspectorProps } from './types'

export function UniverseInspector({ spec, setSpec, stores }: InspectorProps) {
  const store = stores.find((s) => s.key === spec.data_store)

  return (
    <Section title="Universe" columns={1}>
      <Field label="Universe" hint="The names this strategy may hold">
        <UniversePicker
          value={spec.universe}
          onChange={(universe) => setSpec((prev) => ({ ...prev, universe }))}
          store={spec.data_store}
          universes={selectableUniverses(store)}
        />
      </Field>

      <Field label="Benchmark">
        {/* The store's own benchmarks file, not a hardcoded pair — plus
            whatever the spec already holds, because a crypto template arrives
            with BTC-USD and a select that cannot represent its value renders
            blank: a required field looking unset when it is not. */}
        <Choice
          value={spec.benchmark}
          onChange={(benchmark) => setSpec((prev) => ({ ...prev, benchmark }))}
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
  )
}
