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

import { Choice, Section } from '@/components/builder/FormControls'
import { CompatField, choiceOptions } from './compat'
import type { InspectorProps } from './types'

export function LearnerInspector(props: InspectorProps) {
  const { spec, setSpec, models, notes } = props

  // `/models` lists only what imports on this machine, so a model whose backend
  // is missing never appeared here at all — and a spec carrying one (a
  // template, an older saved strategy) rendered it as a bare id with no hint
  // that it could not run. The server now sends every model with the ones it
  // cannot run disabled and the reason attached, which is the difference
  // between a value that looks fine and a run that dies after training starts.
  const labels = new Map(models?.models.map((m) => [m.id, m.label]) ?? [])

  return (
    <Section title="Learner" columns={1}>
      <CompatField field="model" label="Model" ctx={props}>
        <Choice
          value={spec.model}
          onChange={(model) => setSpec((prev) => ({ ...prev, model }))}
          options={choiceOptions(
            props, 'model',
            [...new Set([...(models?.models.map((m) => m.id) ?? []), spec.model])],
            (v) => labels.get(v) ?? v)}
        />
      </CompatField>

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
