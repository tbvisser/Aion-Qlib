/**
 * The two lines every compatibility-aware control needs.
 *
 * Seven inspectors ask the same three questions of one field — what may it be
 * set to, is it currently wrong, and what are the ways out — and answering them
 * inline seven times is how six of them come to disagree with the seventh. The
 * reading logic itself is in `lib/strategyOptions.ts`, which is plain `.ts` and
 * therefore testable; this is only the rendering of it.
 */
import { Field, FieldProblem, type ChoiceOption } from '@/components/builder/FormControls'
import type { StrategySpec } from '@/lib/api'
import {
  boundsFor, defectsFor, noteFor, optionsFor, quarantined, resolutions,
} from '@/lib/strategyOptions'
import type { InspectorProps } from './types'

/** Everything the helpers need, and nothing else, so a caller can pass a subset. */
export type CompatCtx = Pick<InspectorProps, 'spec' | 'options' | 'defects' | 'applyPatch'>

/**
 * The options for one field, ready for `Choice`.
 *
 * `fallback` is what the control would have offered on its own — the models
 * list, the store's benchmarks. It is used only when the server sent nothing,
 * so the builder against an older API behaves exactly as it did before.
 */
export function choiceOptions(
  ctx: CompatCtx, field: keyof StrategySpec, fallback: readonly string[] = [],
  labelFor?: (value: string) => string,
): ChoiceOption[] {
  const current = String(ctx.spec[field] ?? '')
  return optionsFor(ctx.options, field, current, fallback).map((o) => ({
    value: o.value,
    // The server labels a store `us`; the UI has "US market (252-day)". The
    // display name is the client's business and the enablement is the
    // server's, so each side keeps the half it actually knows.
    label: labelFor?.(o.value) ?? o.label,
    enabled: o.enabled,
    reason: o.reason,
  }))
}

export function fieldBounds(ctx: CompatCtx, field: keyof StrategySpec) {
  return boundsFor(ctx.options, field)
}

/**
 * A labelled control that also carries what is wrong with its field.
 *
 * The hint falls back to the server's note for the field, which is where a
 * caveat the option list cannot express ends up — "this store ships no
 * benchmark list, so these are the crypto_top100 names".
 */
export function CompatField({
  field, label, hint, className, ctx, children,
}: {
  field: keyof StrategySpec
  label: string
  hint?: string
  className?: string
  ctx: CompatCtx
  children: React.ReactNode
}) {
  const blocking = defectsFor(ctx.defects ?? [], field)
    .filter((d) => d.severity === 'blocking')
    .map((d) => d.message)

  return (
    <Field label={label} hint={hint ?? noteFor(ctx.options, field) ?? undefined}
           className={className}>
      {children}
      <FieldProblem
        messages={blocking}
        resolutions={resolutions(field, ctx.spec, ctx.options, ctx.defects ?? [])}
        onApply={ctx.applyPatch}
      />
    </Field>
  )
}

/** Whether a run would be refused because of this field. */
export function isQuarantined(ctx: CompatCtx, field: keyof StrategySpec): boolean {
  return quarantined(ctx.defects ?? []).has(field)
}

/**
 * The fields that render their own problems, via `CompatField`.
 *
 * The stage inspector prints the blocking messages routed to its stage in a
 * notice at the top of the rail. That notice is the thing that guarantees no
 * message is ever lost — so rather than removing it, it now skips the fields
 * that show the message themselves, and keeps everything else.
 *
 * Erring in either direction is safe in only one of them: a field missing from
 * this list says the same thing twice, a field wrongly *in* it says it nowhere.
 * So a field is added here only when a `CompatField` actually wraps its control
 * — which is why `open_cost` and friends are absent. They have no server-side
 * check at all, and `features` is reported on the canvas cards instead.
 */
export const COMPAT_FIELDS: ReadonlySet<string> = new Set([
  'data_store', 'universe', 'benchmark', 'handler', 'model',
  'train_start', 'train_end', 'valid_start', 'valid_end', 'test_start', 'test_end',
  'topk', 'n_drop', 'limit_threshold',
])
