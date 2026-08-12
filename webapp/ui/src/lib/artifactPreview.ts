import type { CurvePoint, Run, RunReport, RunStatus } from '@/lib/api'
import { decimate } from '@/lib/curves'
import { featureSetOf, metricRow, summaryRow, type MetricRow } from '@/lib/runMetrics'

/**
 * What a backtest artifact card shows, decided from what is known right now.
 *
 * The report argument carries three states and all three matter: `undefined`
 * means the fetch has not resolved yet, `null` means it resolved to nothing
 * (404, artifacts cleaned up). While the report is in flight the card renders
 * whatever the synchronous data supports — summary stats or the metadata
 * excerpt — and upgrades to the curve when the report lands. There is no
 * loading tier and no "no metrics" tier on purpose: every state has something
 * worth reading.
 */
export type PreviewTier =
  | { kind: 'status'; status: RunStatus; hint: string | null }
  | { kind: 'curve'; values: (number | null)[]; row: MetricRow }
  | { kind: 'stats'; row: MetricRow }
  | { kind: 'facts'; lines: { label: string; value: string }[] }

/** Enough points to carry the shape of a curve at card size, no more. */
const CURVE_POINTS = 40

export function previewTier(run: Run, report: RunReport | null | undefined): PreviewTier {
  if (run.status !== 'succeeded') {
    return {
      kind: 'status',
      status: run.status,
      hint: run.status === 'failed' ? (run.error_hint ?? run.error ?? null) : null,
    }
  }

  const row = report ? metricRow(run, report) : summaryRow(run)

  if (report) {
    const series = usableSeries(report)
    if (series) {
      const sliced = decimate(series, CURVE_POINTS, (p) => p.value)
      return { kind: 'curve', values: sliced.map((p) => p.value), row }
    }
  }

  if (row.ir != null || row.annualised != null || row.maxDrawdown != null) {
    return { kind: 'stats', row }
  }

  return { kind: 'facts', lines: factLines(run) }
}

/**
 * Excess (net of cost) is preferred because it is the same series the summary
 * metrics beside it describe; a strategy curve next to excess-return numbers
 * would be two different measurements sharing a card.
 */
function usableSeries(report: RunReport): CurvePoint[] | null {
  for (const key of ['excess', 'strategy'] as const) {
    const points = report.curves?.[key]
    if (!points) continue
    const finite = points.filter((p) => p.value != null && Number.isFinite(p.value))
    if (finite.length >= 2) return points
  }
  return null
}

/**
 * The metadata excerpt for a run with nothing numeric to show. Absent fields
 * are omitted rather than dashed out — a card is a preview, not a form — but
 * the Features line always renders (`featureSetOf` has its own fallback), so
 * the tier can never come back empty.
 */
function factLines(run: Run): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = []
  if (run.model) lines.push({ label: 'Model', value: run.model })
  lines.push({ label: 'Features', value: featureSetOf(run) })
  if (run.universe) lines.push({ label: 'Universe', value: run.universe })
  if (run.benchmark) lines.push({ label: 'Benchmark', value: run.benchmark })
  if (run.topk != null) {
    const drop = run.n_drop != null ? ` · drop ${run.n_drop}` : ''
    lines.push({ label: 'Portfolio', value: `Top ${run.topk}${drop}` })
  }
  return lines.slice(0, 5)
}
