/**
 * Stage 01 — which store the prices come from.
 *
 * `CoverageBanner` lives here. It is a fact about the store, it is long-form
 * prose, and by its own docblock it never blocks a run — all three of which
 * made it wrong as a permanent banner over the whole builder and right as the
 * body of the stage it describes.
 */
import { RefreshDataDialog } from '@/components/RefreshDataDialog'
import { Choice, Section } from '@/components/builder/FormControls'
import { CoverageBanner } from '@/components/builder/CoverageBanner'
import { applyStore } from '@/lib/storeSwitch'
import { CompatField, choiceOptions } from './compat'
import type { InspectorProps } from './types'

export function StoreInspector(props: InspectorProps) {
  const { spec, setSpec, stores, coverage, onStoresChanged } = props
  const store = stores.find((s) => s.key === spec.data_store)
  const labels = new Map<string, string>(stores.map((s) => [s.key, s.label]))

  return (
    <Section title="Data store" columns={1}>
      <CompatField field="data_store" label="Store" ctx={props}>
        {/* The cascade — universe, benchmark and end date all follow the store
            — is `lib/storeSwitch`'s, shared with the pre-run dialog so the two
            cannot drift into producing different specs from the same click. */}
        {/* The "(not built)" suffix this used to append is gone: the server
            disables the option and gives its own reason, and printing both
            says the same thing twice in the same row. */}
        <Choice
          value={spec.data_store}
          onChange={(v) => setSpec((prev) => applyStore(prev, stores, v))}
          options={choiceOptions(props, 'data_store', stores.map((s) => s.key),
                                 (v) => labels.get(v) ?? v)}
        />
        {store?.exists && (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/70">
            {store.note} {store.calendar_days.toLocaleString()} trading days.
          </p>
        )}
        {store && !store.exists && (
          <div className="mt-2 space-y-2">
            <p className="text-[11px] leading-relaxed text-clay">
              This store has no data yet, so a backtest against it cannot start.
              Build it from EODHD first.
            </p>
            <RefreshDataDialog onFinished={onStoresChanged} />
          </div>
        )}
      </CompatField>

      <CoverageBanner coverage={coverage} />

      {/* A column that computes but is not what it is called.
          `CoverageBanner` deliberately refuses this one — both stores carry a
          proxy, so as a banner it would be permanent and therefore ignored. It
          used to be a footnote under the strategy summary; that panel is gone,
          and this is the honest home for it: a fact about the store, read only
          when you open the store. */}
      {Object.values(coverage?.proxy_columns ?? {}).map((sentence) => (
        <p
          key={sentence}
          className="border-t border-border/50 pt-2 text-[11px] leading-relaxed text-muted-foreground/80"
        >
          {sentence}
        </p>
      ))}
    </Section>
  )
}
