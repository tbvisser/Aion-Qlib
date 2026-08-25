import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Download, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MicroLabel } from '@/components/ui/micro-label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { JobProgress } from '@/components/JobProgress'
import { api, ApiError, type DataStatus, type IngestJob } from '@/lib/api'
import { cn } from '@/lib/utils'

const POLL_MS = 2000

/**
 * Drives the EODHD -> qlib ingest from the UI.
 *
 * The job runs server-side and survives this dialog closing, so on mount we
 * adopt whatever ingest is already running rather than offering to start a
 * second one — two writers would corrupt the binary store, and the API refuses
 * the second anyway.
 */
export function RefreshDataDialog({ onFinished }: { onFinished?: () => void }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<DataStatus | null>(null)
  const [job, setJob] = useState<IngestJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [universeSize, setUniverseSize] = useState(500)
  const [start, setStart] = useState('2010-01-01')
  const notified = useRef(false)

  useEffect(() => {
    api
      .dataStatus()
      .then((s) => {
        setStatus(s)
        if (s.running_job) setJob(s.running_job)
      })
      .catch(() => setStatus(null))
  }, [])

  // Poll while a job is live. Deliberately unconditional on `open`: a user who
  // closes the dialog mid-ingest still gets the completion callback.
  useEffect(() => {
    if (!job || job.status !== 'running') return
    const id = setInterval(() => {
      api
        .refreshJob(job.job_id)
        .then(setJob)
        .catch((e) => setError(e instanceof Error ? e.message : 'Lost the job'))
    }, POLL_MS)
    return () => clearInterval(id)
  }, [job])

  useEffect(() => {
    if (job?.status === 'done' && !notified.current) {
      notified.current = true
      api.dataStatus().then(setStatus).catch(() => {})
      onFinished?.()
    }
  }, [job?.status, onFinished])

  const startIngest = useCallback(async () => {
    setError(null)
    notified.current = false
    try {
      const { job_id } = await api.startRefresh({ universe_size: universeSize, start })
      setJob(await api.refreshJob(job_id))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone else started one; adopt it instead of reporting a failure.
        const s = await api.dataStatus()
        setStatus(s)
        if (s.running_job) setJob(s.running_job)
        return
      }
      setError(e instanceof Error ? e.message : 'Could not start the ingest')
    }
  }, [universeSize, start])

  const running = job?.status === 'running'
  const noKey = status !== null && !status.has_eodhd_key

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {running ? (
            <RotateCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="mr-1.5 h-3.5 w-3.5" />
          )}
          {running ? 'Ingesting…' : 'Refresh data'}
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Refresh market data</DialogTitle>
          <DialogDescription>
            Downloads daily bars from EODHD and rebuilds the binary store. This takes
            several minutes and replaces the current US store.
          </DialogDescription>
        </DialogHeader>

        {noKey && (
          <Callout tone="warn">
            <code className="font-mono text-xs">EODHD_API_KEY</code> is not set — add it to{' '}
            <code className="font-mono text-xs">webapp/.env</code> and restart the API.
          </Callout>
        )}

        {status?.last_ingest && (
          <p className="text-xs text-muted-foreground">
            Last ingest {status.last_ingest.finished_at.slice(0, 16).replace('T', ' ')} UTC ·{' '}
            {status.last_ingest.symbols_written ?? '—'} symbols
          </p>
        )}

        {!job && (
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="universe-size" className="text-xs">
                Universe size
              </Label>
              <Input
                id="universe-size"
                type="number"
                min={1}
                max={5000}
                value={universeSize}
                onChange={(e) => setUniverseSize(Number(e.target.value) || 1)}
                className="h-8 font-mono text-xs"
              />
              <p className="text-label text-muted-foreground">Top N by recent dollar volume.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ingest-start" className="text-xs">
                History from
              </Label>
              <Input
                id="ingest-start"
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="h-8 font-mono text-xs"
              />
              <p className="text-label text-muted-foreground">Earlier costs more requests.</p>
            </div>
          </div>
        )}

        {job && <JobPanel job={job} />}
        {error && <Callout tone="error">{error}</Callout>}

        <DialogFooter>
          {job && job.status !== 'running' ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setJob(null)}>
                New ingest
              </Button>
              <Button size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void startIngest()} disabled={running || noKey}>
              {running ? 'Running…' : 'Start ingest'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function JobPanel({ job }: { job: IngestJob }) {
  const { progress } = job

  return (
    <div className="space-y-3 py-2">
      <JobProgress
        stage={progress.stage}
        message={progress.message}
        done={progress.done}
        total={progress.total}
        running={job.status === 'running'}
        failed={job.status === 'error'}
      />

      {job.status === 'error' && <Callout tone="error">{job.error}</Callout>}

      {job.status === 'done' && job.summary && (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1">
            <Field label="Symbols written" value={String(job.summary.symbols_written)} />
            <Field label="Failed" value={String(job.summary.symbols_failed)} />
            <Field label="Universe" value={job.summary.universe} />
            <Field
              label="Days pruned"
              value={String(job.summary.non_trading_days_pruned)}
            />
          </dl>
          {job.restart_required && (
            <Callout tone="warn">
              The store was built, but this API process is still serving the old one — the
              engine cannot be re-pointed at runtime. Restart the API to load it.
            </Callout>
          )}
        </>
      )}
    </div>
  )
}

function Callout({ tone, children }: { tone: 'warn' | 'error'; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex gap-2 rounded-md border px-3 py-2 text-xs',
        tone === 'error'
          ? 'border-destructive/40 bg-destructive/5 text-destructive'
          : 'border-clay/40 bg-clay/5 text-muted-foreground',
      )}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <MicroLabel as="dt">
        {label}
      </MicroLabel>
      <dd className="tnum truncate font-mono text-sm">{value}</dd>
    </div>
  )
}
