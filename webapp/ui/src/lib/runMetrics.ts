/**
 * A finished run reduced to the few numbers that decide whether it beat the
 * last one, and what was different about it.
 *
 * The backtest ledger grouped repeated attempts at one idea together and then
 * showed no numbers at all — so "which of my five attempts was best?", the
 * question the grouping exists to support, could only be answered by opening
 * five reports one at a time.
 *
 * Everything is read from `excess_return_with_cost`. That is the block the run
 * report leads with, and it is the honest one: gross of cost, a high-turnover
 * strategy can look excellent while losing money.
 */
import type { Run, RunReport, RunSanity } from '@/lib/api'
import { changedKeys, showValue } from '@/lib/specDiff'

export interface MetricRow {
  runId: string
  label: string
  /** Information ratio, net of cost. The ranking key. */
  ir: number | null
  annualised: number | null
  maxDrawdown: number | null
  volatility: number | null
  period: { start: string; end: string } | null
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

export function excessOf(report?: RunReport | null): Record<string, number> {
  return (report?.risk?.['excess_return_with_cost'] ?? {}) as Record<string, number>
}

/**
 * Whether this run's numbers are readable as a result.
 *
 * An accessor rather than components reaching into `report.sanity`, so the
 * absent case -- a report built before the check existed -- has one answer
 * instead of three. Absent means "not judged", which reads as plausible: an old
 * run must not suddenly grow a warning nobody computed.
 */
export function sanityOf(report?: RunReport | null): RunSanity {
  return report?.sanity ?? { implausible: false, reasons: [] }
}

/**
 * A percentage a person can read.
 *
 * Past a certain size the digits stop carrying information: `+7,532,752.7%` is
 * not a more precise `>1000%`, it is the same fact about a broken run with six
 * meaningless digits attached, and it is wide enough to break the column it sits
 * in. Anything inside the band formats exactly as it always did, so no ordinary
 * run's display changes.
 */
export const PLAUSIBLE_PERCENT = 1000

/**
 * `digits` and `sign` exist so the three surfaces that print these metrics keep
 * the conventions they already had -- the ledger signs its returns and shows one
 * decimal, the report shows two and no sign -- while sharing the one clamp.
 * Named `formatRunPercent` rather than `formatPercent` because `macroFormat`
 * exports one of those already and they are not interchangeable.
 */
export function formatRunPercent(value: number, digits = 1, sign = true): string {
  const percent = value * 100
  if (Math.abs(percent) > PLAUSIBLE_PERCENT) {
    return `${percent > 0 ? '>' : '<-'}${PLAUSIBLE_PERCENT.toLocaleString()}%`
  }
  return `${sign && percent > 0 ? '+' : ''}${percent.toFixed(digits)}%`
}

/**
 * What the run's model actually saw, in the builder's own words.
 *
 * `run.handler` alone misreports a `replace` run: the handler's feature set was
 * never loaded, so a panel that prints it names Alpha158 for a run built from
 * four custom factors. The phrasing mirrors what `strategyGraph/glance.ts` puts
 * on the Features card, so the ledger and the canvas agree.
 *
 * Runs started before `feature_mode` was recorded fall back to the handler name.
 * That is the honest answer for them: what was recorded is all that is known.
 */
export function featureSetOf(run: Run): string {
  const handler = run.handler ?? '—'
  if (!run.feature_mode) return handler
  const count = run.feature_count ?? 0
  if (run.feature_mode === 'replace') {
    if (!count) return handler
    return count === 1 ? '1 custom column' : `${count} custom columns`
  }
  return count ? `${handler} + ${count}` : handler
}

export function metricRow(run: Run, report?: RunReport | null): MetricRow {
  const excess = excessOf(report)
  return {
    runId: run.id,
    label: run.name,
    ir: num(excess['information_ratio']),
    annualised: num(excess['annualized_return']),
    maxDrawdown: num(excess['max_drawdown']),
    volatility: num(excess['std']),
    period: report?.period ?? null,
  }
}

/**
 * The same row, built from the compact `summary` a run list carries instead of
 * from a fetched report.
 *
 * `Run.summary` is literally the `excess_return_with_cost` slice `excessOf`
 * pulls out of a report, so the two paths agree by construction. `period` is
 * the one thing the slice cannot carry — a card that shows metrics without a
 * date range is fine; a ledger that needs the range should fetch the report.
 */
export function summaryRow(run: Run): MetricRow {
  const excess = run.summary ?? {}
  return {
    runId: run.id,
    label: run.name,
    ir: num(excess['information_ratio']),
    annualised: num(excess['annualized_return']),
    maxDrawdown: num(excess['max_drawdown']),
    volatility: num(excess['std']),
    period: null,
  }
}

/** Sort key for a leaderboard. Missing metrics sink rather than sorting as zero. */
export const rankValue = (row: MetricRow): number => row.ir ?? -Infinity

export type MetricKey = 'ir' | 'annualised' | 'maxDrawdown' | 'volatility'

/**
 * Which run wins a column.
 *
 * `maxDrawdown` and `volatility` are better when *smaller* — a drawdown of
 * −12% beats one of −30%, and ranking them like returns would crown the worst
 * run in the table.
 */
export function best(rows: readonly MetricRow[], key: MetricKey): string | null {
  const lowerIsBetter = key === 'maxDrawdown' || key === 'volatility'
  let winner: MetricRow | null = null
  for (const row of rows) {
    const value = row[key]
    if (value == null) continue
    if (!winner) { winner = row; continue }
    const current = winner[key] as number
    // Drawdown is negative, so "smaller" means closer to zero: compare
    // magnitude, not the signed value.
    const better = lowerIsBetter
      ? Math.abs(value) < Math.abs(current)
      : value > current
    if (better) winner = row
  }
  return winner?.runId ?? null
}

/** Token class for a metric cell. `null` means neutral — no colour. */
export type MetricTone = 'positive' | 'negative' | null

/**
 * How a metric should be coloured in the backtests ledger.
 *
 * `maxDrawdown` and `volatility` are exempt from the sign rule and always read
 * negative, which is the same call `RunReportView.Metric`'s `negative` flag
 * makes: a max drawdown of −28% is the number, not a verdict. Applying the sign
 * rule to it would paint every run's drawdown clay as though it were a loss
 * and — worse — paint a run with *zero* drawdown mint.
 */
export function metricTone(key: MetricKey, value: number | null): MetricTone {
  if (value === null) return null
  if (key === 'maxDrawdown' || key === 'volatility') return 'negative'
  return value > 0 ? 'positive' : 'negative'
}

export interface DiffRow {
  field: string
  /** Run id -> that run's value for this field. */
  values: Record<string, string>
}

/**
 * What actually differs between the runs being compared.
 *
 * Only over what a `Run` carries in its metadata — model, handler, universe,
 * benchmark, store and (for runs started after that dict was widened) topk,
 * n_drop and the costs. A run from before those keys existed renders an em dash
 * rather than being dropped, because "we did not record this" and "it was the
 * same" are different claims.
 */
const COMPARED: { key: keyof Run; label: string }[] = [
  { key: 'model', label: 'Model' },
  { key: 'handler', label: 'Feature set' },
  { key: 'universe', label: 'Universe' },
  { key: 'benchmark', label: 'Benchmark' },
  { key: 'data_store', label: 'Store' },
  { key: 'topk', label: 'Top K' },
  { key: 'n_drop', label: 'Drop' },
  { key: 'open_cost', label: 'Open cost' },
  { key: 'close_cost', label: 'Close cost' },
]

export function runDiff(runs: readonly Run[]): DiffRow[] {
  if (runs.length < 2) return []

  const rows: DiffRow[] = []
  for (const { key, label } of COMPARED) {
    const values = runs.map((r) => (r as unknown as Record<string, unknown>)[key])
    const first = values[0]
    const differs = values.some((v) => JSON.stringify(v) !== JSON.stringify(first))
    if (!differs) continue
    rows.push({
      field: label,
      values: Object.fromEntries(runs.map((r, i) => [r.id, showValue(values[i])])),
    })
  }
  return rows
}

/** The fields that differ, as a short phrase for a collapsed row. */
export function changedSince(previous: Run | undefined, run: Run): string | null {
  if (!previous) return null
  const keys = changedKeys(
    previous as unknown as Record<string, unknown>,
    run as unknown as Record<string, unknown>,
    // Identity and timing, not decisions.
    ['id', 'name', 'created_at', 'started_at', 'finished_at', 'status', 'phase',
     'exit_code', 'error', 'error_hint', 'experiment_name', 'strategy_id'],
  )
  const labels = keys
    .map((k) => COMPARED.find((c) => c.key === k)?.label)
    .filter(Boolean) as string[]
  return labels.length ? labels.join(', ') : null
}
