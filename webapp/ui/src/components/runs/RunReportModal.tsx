/**
 * A finished run's report, over the builder.
 *
 * Reading a result used to mean leaving for /runs/<id> and coming back to a
 * canvas you had to find your place in again. The report is the thing you read
 * *in order to* change something, so it opens on top of what you would change.
 * `Full page` is still there for when it is the thing you came for.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Printer, X } from 'lucide-react'

import { RunReportView } from '@/components/runs/RunReportView'
import { RunStatusIcon } from '@/components/runs/RunStatusIcon'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { api, type Run, type RunReport } from '@/lib/api'

export function RunReportModal({ run, onClose }: { run: Run | null; onClose: () => void }) {
  const [report, setReport] = useState<RunReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!run) return
    let live = true
    setReport(null)
    setError(null)
    api.runReport(run.id)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'No report for this run'))
    return () => { live = false }
  }, [run])

  return (
    <Dialog open={!!run} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="run-report-modal"
        className="flex max-h-[90vh] w-[min(96vw,72rem)] max-w-none flex-col gap-0 p-0"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border/50 px-5 py-3">
          {run && <RunStatusIcon status={run.status} />}
          <DialogTitle className="min-w-0 flex-1 truncate text-sm">{run?.name}</DialogTitle>

          {/* "Print", not "Diagnostic PDF". There is no PDF pipeline — this
              hands the page to the printer, which every platform can already
              save as a PDF. A label promising a document generator the app does
              not have is the kind of small lie that costs trust in the numbers
              beside it. */}
          <Button variant="outline" size="sm" className="shrink-0"
                  onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" />
            Print
          </Button>
          {run && (
            <Button variant="outline" size="sm" asChild className="shrink-0">
              <Link to={`/runs/${run.id}`}>
                <ExternalLink className="h-3.5 w-3.5" />
                Full page
              </Link>
            </Button>
          )}
          <button
            onClick={onClose}
            title="Close"
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-print-root>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!error && !report && <p className="text-sm text-muted-foreground">Loading report…</p>}
          {report && <RunReportView report={report} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}
