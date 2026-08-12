/**
 * Stage 03 — what the model sees.
 *
 * `handler` is here rather than with the learner because it *is* a feature set
 * — the old `LearnerLine` labelled it exactly that — and `feature_mode` is
 * meaningless without knowing which handler is being extended or replaced.
 *
 * The columns themselves are read-only here. Authoring one needs a block
 * palette, a catalog search and an expression bar, none of which fit a 320px
 * rail; the button opens the factor canvas, which already has all three. A
 * second, smaller expression editor would be a second way to author a feature,
 * and two editors that can disagree is worse than two validators.
 */
import { ArrowUpRight } from 'lucide-react'

import { Choice, Field, Section } from '@/components/builder/FormControls'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import type { FeatureMode } from '@/lib/api'
import type { InspectorProps } from './types'

export function FeaturesInspector({
  spec, setSpec, models, unfinished, onOpenFeatureCanvas,
}: InspectorProps) {
  const columns = spec.features ?? []

  return (
    <Section title="Features" columns={1}>
      <Field
        label="Feature set"
        hint="What the model sees: Alpha158 is 158 engineered factors, Alpha360 is 360 raw price and volume lags."
      >
        <Choice
          value={spec.handler}
          onChange={(handler) => setSpec((prev) => ({ ...prev, handler }))}
          options={(models?.handlers ?? [spec.handler]).map((h) => ({ value: h, label: h }))}
        />
      </Field>

      <Field label="Your columns" hint={columns.length ? undefined : 'None yet — the handler’s own set is used as it is.'}>
        {columns.length > 0 && (
          <div className="mb-2 space-y-1">
            {columns.map((c) => (
              <div
                key={c.name}
                className="flex items-baseline gap-2 rounded-lg border border-border/60 bg-surface-2 px-2.5 py-1.5"
              >
                <span className="shrink-0 font-mono text-[11px] font-medium">{c.name}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground/70" title={c.expression}>
                  {c.expression}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* Not an error, and it must not read as one: an unfinished column is
            simply not in the config yet. */}
        {unfinished > 0 && (
          <Badge variant="muted" className="mb-2">
            {unfinished} unfinished on the canvas
          </Badge>
        )}
        <Button variant="outline" size="sm" className="w-full" onClick={onOpenFeatureCanvas}>
          <ArrowUpRight className="h-3.5 w-3.5" />
          Open factor canvas
        </Button>
      </Field>

      {columns.length > 0 && (
        <Field label="Mode" hint="Extend adds your columns to the handler’s. Replace uses only yours.">
          <Segmented
            value={spec.feature_mode}
            onChange={(feature_mode: FeatureMode) => setSpec((prev) => ({ ...prev, feature_mode }))}
            options={[
              { value: 'extend', label: 'Extend' },
              { value: 'replace', label: 'Replace' },
            ]}
          />
        </Field>
      )}
    </Section>
  )
}
