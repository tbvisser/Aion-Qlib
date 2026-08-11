/**
 * What differs between two specs, and how to print a field.
 *
 * Extracted from `ProposalCard`, which needed it to show a proposal against
 * what is on screen. The run comparison asks the same two questions of two
 * finished runs, and a third copy of `String(value) ?? '—'` is one too many.
 */

/**
 * Keys whose values differ, in `a`'s own key order, then any key only `b` has.
 *
 * Order is deliberately not sorted: a spec's key order is the order it is
 * declared in, which reads far better than alphabetical (`account` first, then
 * `benchmark`, then `close_cost`, is nobody's mental model of a strategy).
 *
 * Compared by `JSON.stringify` rather than `===` because `features` is an array
 * of objects: reference equality would report every spec as wholly changed, and
 * a shallow compare would miss an edited expression.
 */
export function changedKeys(
  a: Record<string, unknown>, b: Record<string, unknown>, ignore: readonly string[] = [],
): string[] {
  const skip = new Set(ignore)
  const ordered = [
    ...Object.keys(a),
    ...Object.keys(b).filter((k) => !(k in a)),
  ]
  return ordered
    .filter((k) => !skip.has(k))
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

/**
 * A field value as one cell of text.
 *
 * `null` and `undefined` both become an em dash: in a spec they mean the same
 * thing to a reader — nobody set this — even though only one of them is a legal
 * wire value.
 *
 * An array is summarised by length rather than serialised. The only array on a
 * spec is `features`, and a column list printed into a table cell is unreadable
 * at any width; the canvas is where those are read.
 */
export function showValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (Array.isArray(value)) {
    return value.length ? `${value.length} column${value.length === 1 ? '' : 's'}` : '—'
  }
  return String(value)
}
