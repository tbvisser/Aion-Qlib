import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  ArrowUpRight,
  Boxes,
  CalendarDays,
  Database,
  FileText,
  Flag,
  LayoutList,
  Loader2,
  Radar,
  TrendingDown,
  TrendingUp,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RunStatusIcon } from '@/components/runs/RunStatusIcon'
import {
  api,
  type IngestJob,
  type MacroRefreshJob,
  type Run,
  type ScheduledTask,
  type TaskOutputSummary,
} from '@/lib/api'
import { cn } from '@/lib/utils'

interface OutputPreviewProps {
  task: ScheduledTask
}

type FetchedOutput =
  | { kind: 'macro_job'; data: MacroRefreshJob }
  | { kind: 'ingest_job'; data: IngestJob }
  | { kind: 'run'; data: Run }

type FetchState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'error'; message: string }
  | { status: 'ok'; output: FetchedOutput }

export function OutputPreview({ task }: OutputPreviewProps) {
  const summary = task.last_output_summary

  // If we already have a persisted plain-language summary, render it directly.
  if (summary) {
    return <SummaryCard task={task} summary={summary} />
  }

  // Legacy fallback: fetch the output object from its id and render a basic card.
  return <FetchedOutputCard task={task} />
}

function SummaryCard({
  task,
  summary,
}: {
  task: ScheduledTask
  summary: TaskOutputSummary
}) {
  if (summary.kind === 'macro_job') {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Radar className="h-4 w-4 text-muted-foreground" />
            Macro refresh
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <StatusLine status={summary.status} error={summary.error} />

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric icon={CalendarDays} label="Calendar rows" value={summary.calendar_rows} />
            <Metric icon={TrendingUp} label="Indicator rows" value={summary.indicator_rows} />
            <Metric icon={Flag} label="Warnings" value={summary.warnings_count} />
          </div>

          {summary.indicators && Object.keys(summary.indicators).length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Indicators refreshed</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(summary.indicators).slice(0, 8).map(([key, rows]) => (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                  >
                    <span className="font-medium">{key.split('/').pop()}</span>
                    <span className="text-muted-foreground">{rows} rows</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          <DeepLink to="/macro" label="Open Macro Desk" />
        </CardContent>
      </Card>
    )
  }

  if (summary.kind === 'ingest_job') {
    const failed = (summary.symbols_failed || 0) > 0
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Database className="h-4 w-4 text-muted-foreground" />
            Data refresh
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <StatusLine status={summary.status} error={summary.error} />

          <p className="text-sm text-muted-foreground">
            Updated the <span className="font-medium text-foreground">{summary.universe || 'qlib'}</span> store
            from <span className="font-medium text-foreground">{summary.start}</span> to{' '}
            <span className="font-medium text-foreground">{summary.end || 'today'}</span>.
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric icon={LayoutList} label="Requested" value={summary.symbols_requested} />
            <Metric icon={TrendingUp} label="Written" value={summary.symbols_written} />
            <Metric icon={TrendingDown} label="Failed" value={summary.symbols_failed} tone={failed ? 'bad' : 'good'} />
            <Metric icon={CalendarDays} label="Days pruned" value={summary.non_trading_days_pruned} />
          </div>

          {failed && summary.failed_sample && summary.failed_sample.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Failed symbols: <span className="font-mono">{summary.failed_sample.join(', ')}</span>
            </p>
          )}

          {summary.restart_required && (
            <p className="rounded-lg bg-clay/10 p-2 text-xs text-clay">
              The store was rebuilt, but the API process needs a restart to serve it.
            </p>
          )}

          <DeepLink to="/markets" label="Open Markets" />
        </CardContent>
      </Card>
    )
  }

  if (summary.kind === 'outlook_report') {
    return <OutlookCard task={task} summary={summary} />
  }

  const run = summary
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Boxes className="h-4 w-4 text-muted-foreground" />
          Strategy run
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div className="flex items-center gap-2 text-sm">
          <RunStatusIcon status={run.status as import('@/lib/api').RunStatus} />
          <span className="font-medium">{run.name || 'Scheduled run'}</span>
        </div>

        <p className="text-sm text-muted-foreground">
          {run.model} · {run.handler} · {run.universe} vs {run.benchmark}
          {run.period_start && run.period_end && (
            <>
              {' '}
              · {run.period_start} → {run.period_end}
            </>
          )}
        </p>

        {run.status === 'succeeded' && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              icon={TrendingUp}
              label="Annual return"
              value={run.annual_return}
              format="percent"
              tone={typeof run.annual_return === 'number' && run.annual_return >= 0 ? 'good' : 'bad'}
            />
            <Metric
              icon={TrendingDown}
              label="Max drawdown"
              value={run.max_drawdown}
              format="percent"
              tone="bad"
            />
            <Metric icon={TrendingUp} label="Info ratio" value={run.information_ratio} />
            <Metric icon={Flag} label="Volatility" value={run.volatility} format="percent" />
          </div>
        )}

        {run.error && (
          <p className="rounded-lg bg-destructive/5 p-2 text-xs text-destructive">{run.error}</p>
        )}

        {task.last_output_id && <DeepLink to={`/runs/${task.last_output_id}`} label="Open run" />}
      </CardContent>
    </Card>
  )
}

function OutlookCard({
  task,
  summary,
}: {
  task: ScheduledTask
  summary: import('@/lib/api').OutlookOutputSummary
}) {
  const [busy, setBusy] = useState(false)
  const isDemo = Boolean(task.is_demo)

  const download = async () => {
    if (!isDemo && !task.last_output_id) return
    setBusy(true)
    let url: string | null = null
    try {
      const blob = isDemo
        ? await api.downloadDemoOutlookReport()
        : await api.downloadOutlookReport(task.last_output_id!)
      url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = isDemo ? 'aion-demo-outlook.pdf' : `${task.name || 'outlook'}.pdf`
      a.click()
    } finally {
      if (url) URL.revokeObjectURL(url)
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4 text-muted-foreground" />
          {summary.title || 'Outlook report'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <StatusLine status={summary.status} />

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric icon={CalendarDays} label="Scope" value={summary.scope} />
          <Metric icon={CalendarDays} label="Date" value={summary.date} />
          <Metric icon={FileText} label="Pages" value={summary.pages} />
          <Metric icon={FileText} label="Size" value={formatFileSize(summary.file_size)} />
        </div>

        {summary.start && summary.end && summary.start !== summary.end && (
          <p className="text-sm text-muted-foreground">
            Covers <span className="font-medium text-foreground">{summary.start}</span> to{' '}
            <span className="font-medium text-foreground">{summary.end}</span>.
          </p>
        )}

        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={busy}
          onClick={() => void download()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
          {isDemo ? 'Open demo PDF' : busy ? 'Opening…' : 'Download PDF'}
        </Button>
      </CardContent>
    </Card>
  )
}

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function FetchedOutputCard({ task }: { task: ScheduledTask }) {
  const [output, setOutput] = useState<FetchState>({ status: 'loading' })

  useEffect(() => {
    if (!task.last_output_id || !task.last_output_kind) {
      setOutput({ status: 'empty' })
      return
    }

    let cancelled = false
    const kind = task.last_output_kind
    const id = task.last_output_id

    const load = async () => {
      try {
        if (kind === 'macro_job') {
          const data = await api.macroRefreshJob(id)
          if (!cancelled) setOutput({ status: 'ok', output: { kind: 'macro_job', data } })
        } else if (kind === 'ingest_job') {
          const data = await api.refreshJob(id)
          if (!cancelled) setOutput({ status: 'ok', output: { kind: 'ingest_job', data } })
        } else if (kind === 'run') {
          const data = await api.getRun(id)
          if (!cancelled) setOutput({ status: 'ok', output: { kind: 'run', data } })
        }
      } catch (err) {
        if (!cancelled) {
          setOutput({
            status: 'error',
            message: err instanceof Error ? err.message : 'Could not load output',
          })
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [task.last_output_id, task.last_output_kind])

  if (output.status === 'loading') {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">Loading output…</CardContent>
      </Card>
    )
  }

  if (output.status === 'empty') {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          No output yet. The next run will appear here.
        </CardContent>
      </Card>
    )
  }

  if (output.status === 'error') {
    return (
      <Card className="border-destructive/40">
        <CardContent className="flex items-start gap-2 py-4 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {output.message}
        </CardContent>
      </Card>
    )
  }

  const { output: out } = output

  if (out.kind === 'macro_job') {
    const job = out.data
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Radar className="h-4 w-4 text-muted-foreground" />
            Macro refresh
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <StatusLine status={job.status} />
          {job.summary && (
            <p className="text-sm text-muted-foreground">
              Calendar: <span className="font-medium text-foreground">{job.summary.calendar_rows}</span> rows ·
              Indicators: <span className="font-medium text-foreground">{job.summary.indicator_rows}</span> rows
            </p>
          )}
          {job.error && (
            <p className="rounded-lg bg-destructive/5 p-2 text-xs text-destructive">{job.error}</p>
          )}
          <DeepLink to="/macro" label="Open Macro Desk" />
        </CardContent>
      </Card>
    )
  }

  if (out.kind === 'ingest_job') {
    const job = out.data
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Database className="h-4 w-4 text-muted-foreground" />
            Data refresh
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <StatusLine status={job.status} />
          {job.summary && (
            <p className="text-sm text-muted-foreground">
              Requested: <span className="font-medium text-foreground">{job.summary.symbols_requested}</span> ·
              Written: <span className="font-medium text-foreground">{job.summary.symbols_written}</span> ·
              Failed: <span className="font-medium text-foreground">{job.summary.symbols_failed}</span>
            </p>
          )}
          {job.restart_required && (
            <p className="rounded-lg bg-clay/10 p-2 text-xs text-clay">
              The store was rebuilt, but the API process needs a restart to serve it.
            </p>
          )}
          {job.error && (
            <p className="rounded-lg bg-destructive/5 p-2 text-xs text-destructive">{job.error}</p>
          )}
          <DeepLink to="/markets" label="Open Markets" />
        </CardContent>
      </Card>
    )
  }

  const run = out.data
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Boxes className="h-4 w-4 text-muted-foreground" />
          Strategy run
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="flex items-center gap-2 text-sm">
          <RunStatusIcon status={run.status} />
          <span>{run.phase}</span>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {run.model} · {run.handler} · {run.universe} vs {run.benchmark}
        </p>
        {run.error_hint && (
          <p className="rounded-lg bg-destructive/5 p-2 text-xs text-destructive">{run.error_hint}</p>
        )}
        {run.error && !run.error_hint && (
          <p className="rounded-lg bg-destructive/5 p-2 text-xs text-destructive">{run.error}</p>
        )}
        <DeepLink to={`/runs/${run.id}`} label="Open run" />
      </CardContent>
    </Card>
  )
}

function StatusLine({ status, error }: { status: string; error?: string | null }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        <StatusDot status={status} />
        <span className="capitalize">{status.replace(/_/g, ' ')}</span>
      </div>
      {error && <p className="rounded-lg bg-destructive/5 p-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function Metric({
  icon: Icon,
  label,
  value,
  format,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string | number | null | undefined
  format?: 'percent' | 'number'
  tone?: 'good' | 'bad'
}) {
  const formatted =
    value == null
      ? '—'
      : format === 'percent' && typeof value === 'number'
        ? `${(value * 100).toFixed(1)}%`
        : typeof value === 'number'
          ? value.toLocaleString()
          : String(value)
  return (
    <div className="rounded-lg bg-muted/50 p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div
        className={cn(
          'text-sm font-semibold',
          tone === 'good' && 'text-primary',
          tone === 'bad' && 'text-destructive',
        )}
      >
        {formatted}
      </div>
    </div>
  )
}

function DeepLink({ to, label }: { to: string; label: string }) {
  return (
    <Button variant="outline" size="sm" className="gap-1" asChild>
      <Link to={to}>
        {label} <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </Button>
  )
}

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'h-2 w-2 rounded-full',
        status === 'done' || status === 'succeeded' ? 'bg-primary' : undefined,
        status === 'running' ? 'bg-primary' : undefined,
        status === 'error' || status === 'failed' ? 'bg-destructive' : undefined,
      )}
    />
  )
}
