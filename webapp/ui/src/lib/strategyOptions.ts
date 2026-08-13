/**
 * What each field may be set to, and what to do about a field that is wrong.
 *
 * The server decides both — `strategy_gen/compat.py` resolves names against the
 * store on disk and the packages actually installed, which is not knowable
 * here. This module is the reading half: it turns one `options` map and one
 * `defects` list into the three questions a control has to answer.
 *
 *   1. May I pick this value?          `optionsFor`
 *   2. Is this field currently wrong?  `quarantined`
 *   3. What are my ways out?           `resolutions`
 *
 * Pure, and in `.ts` rather than beside a component, because `vitest.config.ts`
 * runs `environment: 'node'` with no jsdom — logic that lives in a `.tsx` file
 * is logic no test can reach. Same reason `storeSwitch.ts` lives here.
 *
 * The relationship to `storeSwitch.applyStore` is deliberate and one-way:
 * `applyStore` still owns the *cascade* (change the store, and the universe,
 * benchmark and end date follow), because that is an edit. This module only
 * describes what is allowed. A resolution's `patch` is handed to the cascade
 * rather than applied over it.
 */
import type { FieldOption, FieldOptions, SpecDefect, StrategySpec } from '@/lib/api'

/**
 * The `StrategySpec` field a defect path is about.
 *
 * Paths carry detail past the field — `features[2].name` — because that is what
 * lets a message point at one custom column. Routing keys on the leading
 * segment, so both halves survive.
 */
export function fieldOf(path: string): string {
  return path.split('.')[0].split('[')[0]
}

/** Every defect about `field`, both severities, in server order. */
export function defectsFor(defects: readonly SpecDefect[], field: string): SpecDefect[] {
  return defects.filter((d) => fieldOf(d.path) === field)
}

/**
 * The fields a run would be refused for.
 *
 * Blocking only. An advisory defect describes a run that finishes and means
 * nothing, which is a legitimate thing to ask for — marking those fields as
 * broken is how a reader learns to ignore the marks.
 */
export function quarantined(defects: readonly SpecDefect[]): Set<string> {
  return new Set(defects.filter((d) => d.severity === 'blocking').map((d) => fieldOf(d.path)))
}

/**
 * The options for one field, with `current` guaranteed to appear.
 *
 * A select whose value is not among its options renders blank, which reads as
 * "nothing is chosen" when in fact something is — and on an imported strategy
 * that is exactly the field the reader most needs to see. The server already
 * does this for the fields it knows the spec's value of; this covers the rest,
 * and covers a server too old to send options at all.
 */
export function optionsFor(
  all: Record<string, FieldOptions> | undefined,
  field: string,
  current: string,
  fallback: readonly string[] = [],
): FieldOption[] {
  const known = all?.[field]?.options
  const options: FieldOption[] = known?.length
    ? [...known]
    : fallback.map((value) => ({ value, label: value, enabled: true, reason: null, fix: null }))

  if (current && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: current, enabled: true, reason: null, fix: null })
  }
  return options
}

export function boundsFor(
  all: Record<string, FieldOptions> | undefined, field: string,
): FieldOptions['bounds'] {
  return all?.[field]?.bounds ?? null
}

export function noteFor(
  all: Record<string, FieldOptions> | undefined, field: string,
): string | null {
  return all?.[field]?.note ?? null
}

/**
 * One way to make a quarantined field valid, and what it costs.
 *
 * There are always two shapes of answer and they trade against each other:
 * change the field, or change the thing that made it invalid. `SPY` on the
 * crypto store can be fixed by picking a crypto benchmark — which keeps the
 * store — or by moving to the store that has SPY, which keeps the benchmark.
 * Naming what each one *preserves* is the difference between a choice and a
 * guess, and it is why the import flow marks fields instead of repairing them.
 */
export interface Resolution {
  label: string
  /** What survives if this one is taken, in the reader's own values. */
  preserves: string
  /** The fields to set. Handed to the store cascade, not applied over it. */
  patch: Record<string, unknown>
}

const LABELS: Record<string, string> = {
  data_store: 'store',
  feature_mode: 'feature mode',
}

function fieldLabel(field: string): string {
  return LABELS[field] ?? field
}

/**
 * The ways out of `field`, most-preserving first.
 *
 * Empty when the field is fine, or when nothing on offer would fix it — an
 * empty list is a real answer and the caller should say so rather than render
 * an encouraging blank space.
 */
export function resolutions(
  field: string,
  spec: StrategySpec,
  all: Record<string, FieldOptions> | undefined,
  defects: readonly SpecDefect[],
): Resolution[] {
  if (!quarantined(defects).has(field)) return []

  const values = spec as unknown as Record<string, unknown>
  const current = String(values[field] ?? '')
  const options = optionsFor(all, field, current)
  const out: Resolution[] = []

  // The field that made this one invalid, if the server named it. Only it
  // knows which other store holds the value, so the cause travels on the fix
  // attached to the disabled option rather than on the defect.
  const fix = options.find((o) => o.value === current)?.fix ?? null
  const keptByChanging = fix
    ? `keeps ${String(values[fix.path] ?? '')} as the ${fieldLabel(fix.path)}`
    : ''

  // Change the offending field. The control beside this already offers the
  // whole vocabulary, so this is not the complete path — two is enough to show
  // the reader that the trade exists and which way it runs.
  for (const option of options.filter((o) => o.enabled && o.value !== current).slice(0, 2)) {
    out.push({
      label: `Use ${option.label}`,
      preserves: keptByChanging,
      patch: { [field]: option.value },
    })
  }

  // Change what made it invalid, keeping the value the reader actually chose.
  if (fix) {
    out.push({
      label: fix.label,
      preserves: `keeps ${current} as the ${fieldLabel(field)}`,
      patch: { [fix.path]: fix.value },
    })
  }

  return out
}
