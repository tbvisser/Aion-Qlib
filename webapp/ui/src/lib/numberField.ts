/**
 * Parsing for the builder's numeric fields, separated so it can be tested.
 *
 * The primitive this serves used to commit `Number(e.target.value)` whenever
 * it was not NaN — and `Number('') === 0`, so clearing "Top K" to retype it
 * wrote `topk: 0` into the spec, which the server refuses with a 422 the page
 * could only render as "422 Unprocessable Entity". HTML `min`/`max` constrain
 * the spinner buttons and nothing else, so a typed 600 sailed through the
 * same way.
 *
 * The rule now: only a finite number inside the field's own bounds is worth
 * committing, and everything else becomes a sentence that says what to type —
 * rendered beside the field, which is where the mistake is.
 */

export interface NumberBounds {
  min?: number
  max?: number
}

export type ParsedNumber =
  | { ok: true; value: number }
  | { ok: false; error: string }

/** The sentence for a value outside the bounds, in the field's own units. */
function boundsError({ min, max }: NumberBounds): string {
  if (min !== undefined && max !== undefined) {
    return `Enter a number between ${min} and ${max}.`
  }
  if (min !== undefined) return `Enter a number of at least ${min}.`
  if (max !== undefined) return `Enter a number of ${max} or less.`
  return 'Enter a number.'
}

export function parseNumberField(text: string, bounds: NumberBounds = {}): ParsedNumber {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, error: 'Enter a number.' }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { ok: false, error: 'Enter a number.' }
  if (
    (bounds.min !== undefined && value < bounds.min)
    || (bounds.max !== undefined && value > bounds.max)
  ) {
    return { ok: false, error: boundsError(bounds) }
  }
  return { ok: true, value }
}
