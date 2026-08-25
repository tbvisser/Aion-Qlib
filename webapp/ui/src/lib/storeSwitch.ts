/**
 * Moving a strategy to another store, and everything that has to move with it.
 *
 * A store is one trading calendar over one set of instruments, so changing it
 * invalidates the universe, the benchmark and the end date together: the two
 * stores hold different names, and SPY is not in the crypto store.
 *
 * This lived inline in `StrategyForm`'s Data store `Choice`, untested, and now
 * has a second caller in the pre-run dialog. Two copies of a cascade with
 * guards this specific is how you ship a Start button that sends
 * `crypto_365` + `top500` and gets a 400 back — with the failure appearing at
 * launch rather than at the edit that caused it.
 */
import type { DataStore, StrategySpec } from '@/lib/api'

/**
 * The universes a user may actually pick.
 *
 * `benchmarks` is an instruments file, not a tradable universe; it is listed
 * beside them on the wire and would otherwise appear in the picker.
 */
export function selectableUniverses(store: DataStore | undefined): string[] {
  return (store?.universes ?? []).filter((u) => u !== 'benchmarks')
}

/**
 * `spec` rebased onto `key`. Unknown keys are a no-op, not a reset.
 *
 * Each field follows only when it has to:
 *
 *   universe    kept when the new store lists it, otherwise its first.
 *   benchmark   reassigned only when the new store offers benchmarks *and*
 *               the current one is not among them. A store shipping no
 *               benchmarks file keeps whatever is set, and the backend's
 *               `unknown_benchmark` check is what reports it — guessing here
 *               would overwrite a deliberate choice with a blank.
 *   test_end    the new store's last safely-backtestable date, when it has one.
 *   the window  every period date is clamped into the new store's calendar.
 *               Moving only `test_end` could leave `test_end < test_start` —
 *               or a train window entirely before the store's first bar — and
 *               the failure then surfaced as a server warning one debounced
 *               round-trip later instead of at the edit that caused it.
 */
export function applyStore(
  spec: StrategySpec, stores: readonly DataStore[], key: string,
): StrategySpec {
  const next = stores.find((s) => s.key === key)
  if (!next) return spec

  const universes = selectableUniverses(next)
  const benchmarks = next.benchmarks ?? []

  // ISO dates compare lexicographically. Dates already inside the calendar
  // pass through untouched, so ordering is preserved; a window entirely
  // outside collapses onto the bound, which the preview reports immediately.
  const clamp = (date: string): string => {
    if (next.calendar_start && date < next.calendar_start) return next.calendar_start
    if (next.calendar_end && date > next.calendar_end) return next.calendar_end
    return date
  }

  return {
    ...spec,
    data_store: next.key,
    universe: universes.includes(spec.universe) ? spec.universe : (universes[0] ?? ''),
    benchmark: benchmarks.length && !benchmarks.includes(spec.benchmark)
      ? benchmarks[0]
      : spec.benchmark,
    train_start: clamp(spec.train_start),
    train_end: clamp(spec.train_end),
    valid_start: clamp(spec.valid_start),
    valid_end: clamp(spec.valid_end),
    test_start: clamp(spec.test_start),
    test_end: next.calendar_end ?? spec.test_end,
  }
}
