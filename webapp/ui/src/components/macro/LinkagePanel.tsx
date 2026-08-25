import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MicroLabel } from '@/components/ui/micro-label'
import { Segmented } from '@/components/ui/segmented'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { BetaBars } from '@/components/macro/BetaBars'
import { DriverBars } from '@/components/macro/DriverBars'
import { EventOverlayChart } from '@/components/macro/EventOverlayChart'
import { EventStudyTable } from '@/components/macro/EventStudyTable'
import { RegimeGrid } from '@/components/macro/RegimeGrid'
import {
  api, ApiError, type CurvePoint, type MacroLinkage, type MacroSubjectKind,
  type Portfolio, type StoredStrategy,
} from '@/lib/api'
import { useMacroLinkage } from '@/hooks/useMacro'
import { formatIsoDate } from '@/lib/macroFormat'

type Kind = 'strategy' | 'portfolio'

/**
 * What macro actually drives one strategy or portfolio.
 *
 * The subject is a strategy or a portfolio, never a run directly — a run is an
 * implementation detail the page reports rather than something a user picks.
 * A strategy resolves server-side to its latest successful run, and the
 * provenance line says which.
 */
export function LinkagePanel({
  strategies, portfolios, kind, subjectId, onSubjectChange,
}: {
  strategies: StoredStrategy[]
  portfolios: Portfolio[]
  kind: Kind
  subjectId: string | null
  onSubjectChange: (kind: Kind, id: string | null) => void
}) {
  const subject = subjectId ? { kind: kind as MacroSubjectKind, id: subjectId } : null
  const { linkage, error, loading } = useMacroLinkage(subject)
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null)

  const options = kind === 'strategy'
    ? strategies.map((s) => ({ value: s.id, label: s.name }))
    : portfolios.map((p) => ({ value: p.id, label: p.name }))

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-sm">Macro linkage</CardTitle>
          <div className="flex items-center gap-2">
            <Segmented
              value={kind}
              options={[
                { value: 'strategy', label: 'Strategies' },
                { value: 'portfolio', label: 'Portfolios' },
              ]}
              onChange={(next) => onSubjectChange(next as Kind, null)}
              size="sm"
            />
            <Select
              value={subjectId ?? ''}
              onValueChange={(value) => onSubjectChange(kind, value)}
            >
              <SelectTrigger className="h-8 w-56 text-xs" data-testid="linkage-subject">
                <SelectValue placeholder={`Pick a ${kind}`} />
              </SelectTrigger>
              <SelectContent>
                {options.length === 0 ? (
                  <div className="px-2 py-3 text-xs text-muted-foreground">
                    No {kind === 'strategy' ? 'strategies' : 'portfolios'} saved yet.
                  </div>
                ) : options.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {linkage && (
          <p className="font-mono text-label text-muted-foreground">
            {linkage.run_id ? `from run ${linkage.run_id} · ` : ''}
            {formatIsoDate(linkage.window.start)} → {formatIsoDate(linkage.window.end)} ·{' '}
            {linkage.window.days.toLocaleString()} days
          </p>
        )}
      </CardHeader>

      <CardContent>
        <Body
          subject={subject}
          kind={kind}
          linkage={linkage}
          error={error}
          loading={loading}
          selectedEvent={selectedEvent}
          onSelectEvent={setSelectedEvent}
        />
      </CardContent>
    </Card>
  )
}

function Body({
  subject, kind, linkage, error, loading, selectedEvent, onSelectEvent,
}: {
  subject: { kind: MacroSubjectKind; id: string } | null
  kind: Kind
  linkage: MacroLinkage | null
  error: string | null
  loading: boolean
  selectedEvent: string | null
  onSelectEvent: (key: string | null) => void
}) {
  // Three distinct empty states that must not collapse into one.
  if (!subject) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Pick a {kind} to see what macro drives it.
      </p>
    )
  }

  if (error) {
    // A subject with no completed run is a *true fact about the data*, not a
    // failure — clay, with the next action, rather than a red error card.
    const neverRun = /no completed run|has no returns|recorded no results/i.test(error)
    if (neverRun) {
      return (
        <div className="rounded-lg border border-clay/40 bg-clay/5 p-4">
          <p className="text-sm">{error}</p>
          <Link
            to="/lab/builder"
            className="mt-2 inline-flex items-center gap-1 font-mono text-label text-primary hover:underline"
          >
            Run a backtest <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>
      )
    }
    return (
      <div className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
        {error}
      </div>
    )
  }

  if (!linkage) {
    return <div className="h-64 animate-subtle-pulse" />
  }

  return (
    <div className={loading ? 'animate-subtle-pulse' : undefined}>
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Drivers" note={linkage.notes.drivers}>
          <DriverBars drivers={linkage.drivers} />
        </Panel>

        <Panel title="Factor betas" note={linkage.notes.betas}>
          {linkage.betas && <BetaBars model={linkage.betas} />}
        </Panel>

        <Panel title="Regime attribution" note={linkage.notes.regimes}>
          {linkage.regimes && <RegimeGrid report={linkage.regimes} />}
        </Panel>

        <Panel title="Economic releases" note={linkage.notes.events}>
          <EventStudyTable
            events={linkage.events}
            selected={selectedEvent}
            onSelect={onSelectEvent}
          />
        </Panel>
      </div>

      {selectedEvent && (
        <EventOverlay
          linkage={linkage}
          eventKey={selectedEvent}
        />
      )}
    </div>
  )
}

function Panel({
  title, note, children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <MicroLabel as="div" className="mb-2">
        {title}
      </MicroLabel>
      {note ? (
        <div className="rounded-lg border border-clay/40 bg-clay/5 p-3 text-xs">{note}</div>
      ) : (
        children
      )}
    </div>
  )
}

/**
 * The selected release type marked on the subject's own equity curve.
 *
 * Fetched here rather than in the parent because it is only needed once a row
 * is clicked, and the curve can be large.
 */
function EventOverlay({ linkage, eventKey }: { linkage: MacroLinkage; eventKey: string }) {
  const [curves, setCurves] = useState<Record<string, CurvePoint[]> | null>(null)
  const [dates, setDates] = useState<string[]>([])
  const [failed, setFailed] = useState<string | null>(null)

  const row = linkage.events.find((e) => e.event_key === eventKey)

  useEffect(() => {
    let cancelled = false
    setCurves(null)
    setFailed(null)

    void (async () => {
      try {
        const [report, calendar] = await Promise.all([
          linkage.run_id
            ? api.runReport(linkage.run_id)
            : api.portfolioNav(linkage.subject.id),
          api.macroCalendar({
            from: linkage.window.start,
            to: linkage.window.end,
            type: eventKey,
            limit: 2000,
          }),
        ])
        if (cancelled) return
        setCurves(report.curves as unknown as Record<string, CurvePoint[]>)
        setDates([...calendar.past, ...calendar.upcoming].map((r) => r.date))
      } catch (err) {
        if (cancelled) return
        setFailed(err instanceof ApiError ? err.message : 'Could not load the curve')
      }
    })()

    return () => { cancelled = true }
  }, [linkage.run_id, linkage.subject.id, linkage.window.start, linkage.window.end, eventKey])

  if (failed) {
    return (
      <div className="mt-6 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
        {failed}
      </div>
    )
  }

  return (
    <div className="mt-6">
      <MicroLabel as="div" className="mb-2">
        Cumulative return, with {row?.type ?? eventKey} releases marked
      </MicroLabel>
      {curves ? (
        <EventOverlayChart
          curves={curves}
          markerDates={dates}
          markerLabel={row?.type ?? eventKey}
        />
      ) : (
        <div className="h-56 animate-subtle-pulse" />
      )}
    </div>
  )
}
