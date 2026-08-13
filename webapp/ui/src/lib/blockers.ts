/**
 * The one list of reasons the Run button is off, with nothing said twice.
 *
 * Two sources describe overlapping problems:
 *
 *   the preview   `/strategies/preview` runs `validate_windows` and
 *                 `validate_features` over the whole spec. Only it knows about
 *                 window overlaps and the calendar clamp.
 *   the canvas    name and completeness checks, plus — since the live
 *                 `/factors/validate` wiring — the server's read of the active
 *                 column's expression.
 *
 * The overlap is real and grew. Two rules, because the two kinds of duplicate
 * look different:
 *
 * **By message.** Expression defects (lookahead, negative window, unbounded
 * history, unknown field) come from the same `inspect_expression` on both paths,
 * so the strings are byte-identical. These messages contain no backticks at all,
 * which is why the name rule below cannot catch them.
 *
 * **By backticked name.** A column collision or a duplicate name is worded
 * differently by the two sides — the client says one thing, `inspect_features`
 * another — so identity does not help. What they share is the column, and the
 * server always writes it in backticks. Matching a bare substring instead was a
 * real bug: a column legally named `a` matched every warning containing the
 * letter, so naming one column `a` silently hid "Test overlaps validation —
 * results would be optimistic."
 */

import type { SpecDefect } from '@/lib/api'

/**
 * Does this warning name that column?
 *
 * The backtick rule, in one place. `strategyGraph/routeWarning.ts` needs the
 * same question answered to decide whether a warning belongs on the Features
 * card, and re-deriving it there would invite the bare-substring bug described
 * above straight back in.
 */
export function mentionsColumn(warning: string, name: string): boolean {
  return warning.includes(`\`${name}\``)
}

/** Only what the merge needs, so callers are not forced to build a `FeatureIssue`. */
export interface BlockerIssue {
  message: string
  /** The column's display name, when the issue is about one. */
  columnName?: string | null
}

/**
 * Client issues first in precedence, preview warnings second, in that order.
 *
 * The canvas's copy wins when both describe the same column, because it is the
 * one attached to a card the reader can see and click.
 */
export function mergeBlockers(
  warnings: readonly string[], issues: readonly BlockerIssue[],
): string[] {
  const said = new Set(issues.map((i) => i.message))
  const flagged = issues
    .map((i) => i.columnName)
    .filter((name): name is string => Boolean(name))

  const kept = warnings.filter((w) =>
    !said.has(w) && !flagged.some((name) => mentionsColumn(w, name)))

  return [...kept, ...issues.map((i) => i.message)]
}

/**
 * `mergeBlockers`, on defects.
 *
 * Same two rules and the same precedence — the canvas's copy wins, because it
 * is the one attached to a card the reader can see and click. The only
 * difference is what a surviving client issue becomes: a blocking defect on
 * `features`, which is true of every check the canvas performs and is what lets
 * it route and quarantine alongside the server's own.
 */
export function mergeDefects(
  defects: readonly SpecDefect[], issues: readonly BlockerIssue[],
): SpecDefect[] {
  const said = new Set(issues.map((i) => i.message))
  const flagged = issues
    .map((i) => i.columnName)
    .filter((name): name is string => Boolean(name))

  const kept = defects.filter((d) =>
    !said.has(d.message) && !flagged.some((name) => mentionsColumn(d.message, name)))

  return [
    ...kept,
    ...issues.map((i) => ({
      code: 'canvas',
      message: i.message,
      path: i.columnName ? `features.${i.columnName}` : 'features',
      severity: 'blocking' as const,
    })),
  ]
}
