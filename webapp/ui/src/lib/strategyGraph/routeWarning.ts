/**
 * Which stage card a preview warning belongs on.
 *
 * The builder used to print every warning in one stack above the form, so
 * routing did not matter. On a canvas the wall of text is gone and the badge on
 * the card is how a problem is found, which makes a mis-route worse than no
 * route: it sends the reader to a stage that is fine.
 *
 * Two rules, in order, and no catch-all:
 *
 *   1. An exact prefix from `StrategySpec.validate_windows` -> `periods`.
 *      A prefix table rather than keyword sniffing, because "test" and "train"
 *      appear in half the sentences the backend can emit.
 *   2. A live column name in backticks -> `features`, using the same
 *      `mentionsColumn` rule `lib/blockers.ts` applies. That rule exists
 *      because a bare substring match let a column named `a` swallow
 *      "Test overlaps validation -- results would be optimistic."
 *
 * Anything else routes to `null` and is shown page-level. The invariant
 * `routeWarnings` is tested against is that it never drops a warning: a server
 * string this file has not met must still reach the screen.
 */
import { mentionsColumn } from '@/lib/blockers'
import type { StageId } from './stages'

/**
 * The complete output of `StrategySpec.validate_windows`
 * (webapp/api/strategies.py). Prefixes, because the last one interpolates dates.
 *
 * Exported so `routeWarning.test.ts` can assert there is one entry per branch
 * of that method -- the test is the thing that notices when the backend adds a
 * sixth and this table does not.
 */
export const WINDOW_WARNING_PREFIXES: readonly string[] = [
  'Train end is before train start.',
  'Validation overlaps training',
  'Test overlaps validation',
  'Test end is before test start.',
  'Test end ',   // "...is past the last date this store can safely backtest"
]

/**
 * Feature-set warnings that name no column, from
 * `factorlab/expressions.inspect_features`.
 */
const FEATURE_WARNING_PREFIXES: readonly string[] = [
  "Replacing the handler's features needs at least one of your own",
]

export interface RoutedWarning {
  /** null when no rule matched. Never a fallback stage. */
  stage: StageId | null
  message: string
}

/** Only what routing needs, so callers need not build a `FeatureDraft`. */
export interface RoutableColumn {
  name: string
}

function route(warning: string, columns: readonly RoutableColumn[]): StageId | null {
  if (WINDOW_WARNING_PREFIXES.some((p) => warning.startsWith(p))) return 'periods'
  if (FEATURE_WARNING_PREFIXES.some((p) => warning.startsWith(p))) return 'features'
  if (columns.some((c) => c.name && mentionsColumn(warning, c.name))) return 'features'
  return null
}

/**
 * Every warning, each with the stage it belongs on.
 *
 * Output length always equals input length. Nothing is merged, deduplicated or
 * dropped here -- `mergeBlockers` already did that upstream, and doing it twice
 * is how a warning disappears.
 */
export function routeWarnings(
  warnings: readonly string[], columns: readonly RoutableColumn[] = [],
): RoutedWarning[] {
  return warnings.map((message) => ({ stage: route(message, columns), message }))
}

/** The routed warnings for one stage, in input order. */
export function warningsFor(routed: readonly RoutedWarning[], stage: StageId): string[] {
  return routed.filter((r) => r.stage === stage).map((r) => r.message)
}

/** Warnings no rule claimed. Shown page-level so a new server string cannot vanish. */
export function unroutedWarnings(routed: readonly RoutedWarning[]): string[] {
  return routed.filter((r) => r.stage === null).map((r) => r.message)
}
