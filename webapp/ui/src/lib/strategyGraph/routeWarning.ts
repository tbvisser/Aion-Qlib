/**
 * Which stage card a preview warning belongs on.
 *
 * The builder used to print every warning in one stack above the form, so
 * routing did not matter. On a canvas the wall of text is gone and the badge on
 * the card is how a problem is found, which makes a mis-route worse than no
 * route: it sends the reader to a stage that is fine.
 *
 * **Prefer `routeDefects`.** The server now names the field each defect is
 * about and whether it blocks, so routing is a lookup through `STAGE_BY_FIELD`
 * and severity is read rather than guessed. `routeWarnings` and the prefix
 * tables below are what came before that, kept as the fallback for an older
 * server and for a defect whose path names no spec field.
 *
 * The fallback is two rules, in order, and no catch-all:
 *
 *   1. An exact prefix from `StrategySpec.validate_windows` -> `periods`.
 *      A prefix table rather than keyword sniffing, because "test" and "train"
 *      appear in half the sentences the backend can emit.
 *   2. A live column name in backticks -> `features`, using the same
 *      `mentionsColumn` rule `lib/blockers.ts` applies. That rule exists
 *      because a bare substring match let a column named `a` swallow
 *      "Test overlaps validation -- results would be optimistic."
 *
 * Anything else routes to `null` and is shown page-level. The invariant both
 * routers are tested against is that they never drop a warning: a server string
 * this file has not met must still reach the screen.
 */
import type { SpecDefect } from '@/lib/api'
import { mentionsColumn } from '@/lib/blockers'
import { fieldOf } from '@/lib/strategyOptions'
import { STAGES, STAGE_ORDER, type StageId } from './stages'

/**
 * Which stage owns each `StrategySpec` field.
 *
 * Inverted from `STAGES[*].owns`, which `stages.test.ts` already asserts covers
 * every field except `name`. That assertion is what makes this total: a defect
 * carrying a real field name always has somewhere to land, so the prefix rules
 * below are a fallback for a server too old to send paths rather than the
 * primary mechanism they used to be.
 */
export const STAGE_BY_FIELD: ReadonlyMap<string, StageId> = new Map(
  STAGE_ORDER.flatMap((id) => STAGES[id].owns.map((f) => [f as string, id] as const)),
)

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

/**
 * The complete output of `StrategySpec.validate_execution`
 * (webapp/api/strategies.py), each mapped to the stage that owns the field it is
 * about. Unlike the window warnings these do not share one stage: an unfiltered
 * universe, a one-name book and a missing fill guard are three different edits.
 *
 * Exported so `routeWarning.test.ts` can assert there is one entry per branch of
 * that method. Matched before the column rule, so a column named `names` or
 * `held` cannot claim one of these for `features`.
 */
export const EXECUTION_WARNING_ROUTES: readonly (readonly [string, StageId])[] = [
  ['Universe ', 'universe'],
  ['Holding ', 'portfolio'],
  ['Nothing caps a daily move', 'costs'],
]

export interface RoutedWarning {
  /** null when no rule matched. Never a fallback stage. */
  stage: StageId | null
  message: string
  /**
   * True for a warning that describes a run which will complete and mean
   * nothing, false for one that describes a run that should not start.
   *
   * The distinction has to travel with the warning because the two look
   * identical as strings. Everything from `validate_windows` and
   * `inspect_features` is blocking, as it always was; `validate_execution` is
   * the first non-blocking tier, and folding it in with the rest would claim a
   * strategy cannot run when it can — and would break every downstream edge on
   * the canvas saying so.
   */
  advisory: boolean
  /** The `SpecDefect` path, when the warning came from one. */
  path?: string
  /** The `SpecDefect` code, when the warning came from one. */
  code?: string
}

/** Only what routing needs, so callers need not build a `FeatureDraft`. */
export interface RoutableColumn {
  name: string
}

/** True for a warning about a run that will finish and mean nothing. */
export function isAdvisoryWarning(warning: string): boolean {
  return EXECUTION_WARNING_ROUTES.some(([prefix]) => warning.startsWith(prefix))
}

function route(warning: string, columns: readonly RoutableColumn[]): StageId | null {
  if (WINDOW_WARNING_PREFIXES.some((p) => warning.startsWith(p))) return 'periods'
  if (FEATURE_WARNING_PREFIXES.some((p) => warning.startsWith(p))) return 'features'
  const execution = EXECUTION_WARNING_ROUTES.find(([p]) => warning.startsWith(p))
  if (execution) return execution[1]
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
  return warnings.map((message) => ({
    stage: route(message, columns),
    message,
    advisory: isAdvisoryWarning(message),
  }))
}

/**
 * Every defect, each with the stage it belongs on.
 *
 * The same output as `routeWarnings`, arrived at by looking up rather than
 * guessing: the stage comes from the field the server named, and the severity
 * is the one the server assigned. Both of those used to be inferred from the
 * message text, which meant rewording a sentence could move it to another card
 * or silently change whether a strategy counted as runnable.
 *
 * The prefix rules stay as a fallback, for two cases: a path naming something
 * that is not a spec field, and a server old enough to send a defect without
 * one. Unrouted still means unrouted — page-level, never a fallback stage.
 */
export function routeDefects(
  defects: readonly SpecDefect[], columns: readonly RoutableColumn[] = [],
): RoutedWarning[] {
  return defects.map((d) => ({
    stage: STAGE_BY_FIELD.get(fieldOf(d.path ?? '')) ?? route(d.message, columns),
    message: d.message,
    advisory: d.severity === 'advisory',
    path: d.path,
    code: d.code,
  }))
}

/** The routed warnings for one stage, in input order. */
export function warningsFor(routed: readonly RoutedWarning[], stage: StageId): string[] {
  return routed.filter((r) => r.stage === stage).map((r) => r.message)
}

/** The ones for this stage that stop a run, in input order. */
export function blockingFor(routed: readonly RoutedWarning[], stage: StageId): string[] {
  return routed.filter((r) => r.stage === stage && !r.advisory).map((r) => r.message)
}

/** The ones for this stage that only make a run meaningless, in input order. */
export function advisoryFor(routed: readonly RoutedWarning[], stage: StageId): string[] {
  return routed.filter((r) => r.stage === stage && r.advisory).map((r) => r.message)
}

/** Warnings no rule claimed. Shown page-level so a new server string cannot vanish. */
export function unroutedWarnings(routed: readonly RoutedWarning[]): string[] {
  return routed.filter((r) => r.stage === null).map((r) => r.message)
}
