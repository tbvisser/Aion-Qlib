import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'

import { JobProgress } from '@/components/JobProgress'
import { Button } from '@/components/ui/button'
import { api, ApiError, type MacroRefreshJob } from '@/lib/api'

const POLL_MS = 2000

/**
 * Starts a macro refresh and follows it to the end.
 *
 * The first UI surface for `POST /api/macro/refresh` — until now the job
 * existed only as an endpoint. Same shape as RefreshDataDialog's flow: start,
 * poll the job by id, call back once on a terminal status. A 409 means a
 * refresh is already running server-side; that is a success for our purposes
 * (the activity feed carries the running job), not an error to display.
 */
export function MacroRefreshButton({
  what = 'all',
  label = 'Refresh macro',
  disabled = false,
  showProgress = false,
  onFinished,
}: {
  what?: 'all' | 'calendar' | 'indicators'
  label?: string
  /** e.g. "a macro refresh is already in the activity feed". */
  disabled?: boolean
  /** Render the job's progress bar under the button (popover flows). */
  showProgress?: boolean
  onFinished?: () => void
}) {
  const [job, setJob] = useState<MacroRefreshJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const notified = useRef(false)

  // Poll while live — unconditional on any parent visibility, matching
  // RefreshDataDialog: whoever mounted us may re-render freely.
  useEffect(() => {
    if (!job || job.status !== 'running') return
    const id = setInterval(() => {
      api.macroRefreshJob(job.job_id).then(setJob).catch(() => {})
    }, POLL_MS)
    return () => clearInterval(id)
  }, [job])

  useEffect(() => {
    if (job && job.status !== 'running' && !notified.current) {
      notified.current = true
      onFinished?.()
    }
  }, [job, onFinished])

  const start = useCallback(async () => {
    setError(null)
    notified.current = false
    try {
      const { job_id } = await api.startMacroRefresh({ what })
      setJob(await api.macroRefreshJob(job_id))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        onFinished?.()
        return
      }
      setError(e instanceof Error ? e.message : 'Could not start the refresh')
    }
  }, [what, onFinished])

  const running = job?.status === 'running'

  return (
    <div className="min-w-0 space-y-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => void start()}
        disabled={disabled || running}
      >
        {running && <RotateCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        {running ? 'Refreshing…' : label}
      </Button>
      {showProgress && job && (
        <JobProgress
          stage={job.progress.stage}
          message={job.progress.message}
          done={job.progress.done}
          total={job.progress.total}
          running={running}
          failed={job.status === 'error'}
        />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
