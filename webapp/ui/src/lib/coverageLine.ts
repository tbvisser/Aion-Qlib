/**
 * One line of pre-run advisory for one model × feature-set combination.
 *
 * Lives here rather than inside `TrainPanel` because of what it got wrong. It
 * used to read `dead_columns` and nothing else, so it answered "every column
 * this handler needs is present" for a spec whose own custom factors were about
 * to end the run — the endpoint had already returned `partial_columns` and
 * `proxy_columns`, and this dropped both on the floor. A sentence that claims
 * more than it checked is worse than no sentence, and the only way to hold that
 * claim still is to test it, which needs it out of the component.
 *
 * `CoverageBanner` says the same things at length in the builder, where there is
 * room for a paragraph each. Here there is one line per row and up to eight
 * rows, so each clause is the shortest form that stays true.
 */
import type { StrategyCoverage } from '@/lib/api'

/** The one string that means "nothing to flag". Exported so a test can pin it. */
export const ALL_CLEAR = 'every column this run needs is present'

const LIST = (names: string[], max = 3) =>
  names.length <= max
    ? names.join(', ')
    : `${names.slice(0, max).join(', ')}, +${names.length - max} more`

export function coverageLine(coverage?: StrategyCoverage): string {
  if (!coverage) return 'checking…'
  if (!coverage.checked) return 'store could not be read — the run will say why'

  const clauses: string[] = []

  // Worst first: a dead column is the only one of these that would have cost a
  // run, and it is the reason this line exists at all. It still never blocks —
  // the generated config drops the column — so the clause names the mitigation
  // in the same breath. A warning that only names the danger and omits the
  // mitigation teaches people to ignore warnings.
  const dead = coverage.dead_columns
  if (dead.length) {
    const missing = `${dead.length} ${coverage.handler} column${dead.length === 1 ? '' : 's'}`
    clauses.push(coverage.dropped
      ? `${missing} missing (${LIST(dead)}) — dropped before training`
      : `${missing} missing (${LIST(dead)})`)
  }

  // The spec's own factors. Reported apart from the handler's columns because
  // the reader wrote these and can change them; nobody can change Alpha158.
  const featurePartial = coverage.feature_partial_fields ?? []
  if (featurePartial.length) {
    clauses.push(
      `your factors read ${LIST(featurePartial.map((f) => `$${f}`))}, which only some ` +
      `instruments carry — the rest drop out of the cross-section`)
  }

  const featureProxy = Object.keys(coverage.feature_proxy_fields ?? {})
  if (featureProxy.length) {
    clauses.push(
      `your factors read ${LIST(featureProxy.map((f) => `$${f}`))}, which is a ` +
      `stand-in on this store — see what it holds before reading the score`)
  }

  // Store-wide, not spec-specific, and last for that reason: it is true of every
  // strategy against this store whether or not this one is affected.
  const partial = coverage.partial_columns
  if (partial.length) {
    clauses.push(`${LIST(partial.map((c) => `$${c}`))} present for some instruments only`)
  }

  // Deliberately silent about store-wide `proxy_columns`. Both stores carry one,
  // so it would append the same clause to every row of every sweep forever —
  // the failure `CoverageBanner`'s docblock warns about. It matters when a
  // factor actually reads it, which is the clause above.

  return clauses.length ? clauses.join('; ') : ALL_CLEAR
}
