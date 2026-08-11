import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RunLog } from '@/components/runs/RunLog'
import { RunReportView } from '@/components/runs/RunReportView'
import { RunStatusIcon } from '@/components/runs/RunStatusIcon'
import { isActive, useRunStream } from '@/hooks/useRunStream'
import { api, type Run } from '@/lib/api'
import { cn } from '@/lib/utils'

export function RunsPage() {
  const { runId } = useParams()
  const navigate = useNavigate()
  const [runs, setRuns] = useState<Run[]>([])

  const refresh = useCallback(async () => {
    try {
      setRuns((await api.listRuns()).runs)
    } catch {
      /* the API being briefly down should not blank the list */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 5000)
    return () => clearInterval(id)
  }, [refresh])

  return (
    <>
      <PageHeader title="Runs" description="Backtests and their results." />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border/50 p-2">
          {runs.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">
              No runs yet. Start one from the Strategy Builder.
            </p>
          )}
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => navigate(`/runs/${r.id}`)}
              className={cn(
                'mb-1 w-full rounded-md px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.04]',
                r.id === runId && 'bg-foreground/[0.07]',
              )}
            >
              <div className="flex items-center gap-2">
                <RunStatusIcon status={r.status} />
                <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
              </div>
              <div className="mt-0.5 pl-6 font-mono text-[10px] text-muted-foreground">
                {r.model} · {new Date(r.created_at).toLocaleString()}
              </div>
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {runId ? <RunDetail runId={runId} onChange={refresh} /> : (
            <p className="text-sm text-muted-foreground">Select a run.</p>
          )}
        </div>
      </div>
    </>
  )
}

function RunDetail({ runId, onChange }: { runId: string; onChange: () => void }) {
  const { run, log, report, cancel, cancelling } = useRunStream(runId, onChange)

  if (!run) return <p className="text-sm text-muted-foreground">Loading…</p>

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{run.name}</h2>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {run.model} · {run.handler} · {run.universe} vs {run.benchmark} · {run.id}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-1.5 font-mono text-xs">
            <RunStatusIcon status={run.status} />
            {run.phase}
          </span>
          {isActive(run) && (
            <Button variant="outline" size="sm" disabled={cancelling} onClick={cancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      {run.error && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-destructive">Run failed</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11px]">
              {run.error}
            </pre>
          </CardContent>
        </Card>
      )}

      {report && <RunReportView report={report} />}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Log</CardTitle>
        </CardHeader>
        <CardContent>
          <RunLog lines={log} className="h-80" />
        </CardContent>
      </Card>
    </div>
  )
}
