/**
 * Runs gathered under the strategy that produced them.
 *
 * Extracted from `BacktestsPanel` when the panel absorbed the run dock, because
 * the merged panel adds one rule the inline version did not have — the open
 * strategy's group sorts first — and grouping logic with an ordering rule in it
 * is worth a test.
 */
import type { Run } from '@/lib/api'

export interface RunGroup {
  /** `strategy_id` when the run came from a saved strategy, else its name. */
  key: string
  /** What to print. The newest run's name, which is what the spec was called. */
  label: string
  /** Newest first, preserving the order runs arrived in. */
  runs: Run[]
}

/**
 * Group by saved strategy, falling back to the run's name.
 *
 * The fallback matters both ways. Runs started before a strategy was saved
 * carry no `strategy_id`, and filing all of those under one "unsaved" heading
 * would put unrelated experiments together — their name is the better key.
 * Conversely two *saved* strategies that happen to share a name must stay
 * apart, which the id gives for free.
 *
 * `currentStrategyId` floats the open strategy's group to the top: it is the
 * one being iterated on, and scrolling to find your own last attempt is the
 * thing the ledger exists to prevent.
 */
export function groupRuns(runs: readonly Run[], currentStrategyId?: string): RunGroup[] {
  const out = new Map<string, RunGroup>()
  for (const run of runs) {
    const key = run.strategy_id ?? run.name
    const group = out.get(key) ?? { key, label: run.name, runs: [] }
    group.runs.push(run)
    out.set(key, group)
  }

  const groups = [...out.values()]
  if (!currentStrategyId) return groups
  const mine = groups.findIndex((g) => g.key === currentStrategyId)
  if (mine <= 0) return groups
  return [groups[mine], ...groups.slice(0, mine), ...groups.slice(mine + 1)]
}
