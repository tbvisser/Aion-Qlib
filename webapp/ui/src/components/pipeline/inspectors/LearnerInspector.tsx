/**
 * Stage 05 — what fits the signal.
 *
 * One field, deliberately. `LearnerLine`, which this replaces, spent a popover
 * and a docblock arguing that the model is "a setting with a default, not the
 * first decision"; a card at position 05 makes the same argument structurally
 * and needs no popover to do it.
 *
 * Which model *wins* is ML Studio's question, asked across several at once.
 * The link stays because that is the honest next step from here.
 */
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'

import { Choice, Field, Section } from '@/components/builder/FormControls'
import type { InspectorProps } from './types'

export function LearnerInspector({ spec, setSpec, models, notes }: InspectorProps) {
  // The catalog's label ("LightGBM"), falling back to the id. A spec carrying a
  // model this machine cannot offer — a template, an older saved strategy —
  // must still render its own value rather than an empty select.
  const options = [...new Set([...(models?.models.map((m) => m.id) ?? []), spec.model])]
    .map((id) => ({
      value: id,
      label: models?.models.find((m) => m.id === id)?.label ?? id,
    }))

  return (
    <Section title="Learner" columns={1}>
      <Field label="Model">
        <Choice
          value={spec.model}
          onChange={(model) => setSpec((prev) => ({ ...prev, model }))}
          options={options}
        />
      </Field>

      {notes.map((note) => (
        <p key={note} className="text-[11px] leading-relaxed text-muted-foreground">{note}</p>
      ))}

      <Link
        to="/lab/ml-studio"
        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
      >
        Sweep several models at once in ML Studio
        <ArrowUpRight className="h-3 w-3" />
      </Link>
    </Section>
  )
}
