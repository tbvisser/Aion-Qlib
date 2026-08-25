import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { Panel } from '@/components/ui/panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TabNav } from '@/components/ui/tab-nav'
import { PageHeader } from '@/components/layout/PageHeader'
import { CountryIndicatorPanel } from '@/components/macro/CountryIndicatorPanel'
import { CrossAssetBoard } from '@/components/macro/CrossAssetBoard'
import { EconomicCalendar } from '@/components/macro/EconomicCalendar'
import { LinkagePanel } from '@/components/macro/LinkagePanel'
import { RegimePlaybook } from '@/components/macro/RegimePlaybook'
import { RegimeRibbon, type RibbonLens } from '@/components/macro/RegimeRibbon'
import { RegimeVerdict } from '@/components/macro/RegimeVerdict'
import { SeriesExplorer } from '@/components/macro/SeriesExplorer'
import type { SeriesMode } from '@/components/macro/MacroSeriesChart'
import {
  useCountryIndicators, useMacroCalendar, useMacroCurve, useMacroPlaybook,
  useMacroRegime, useMacroRegimeHistory, useMacroRegistry, useMacroSeriesData,
  useMacroSnapshot,
} from '@/hooks/useMacro'
import { useMacroAlerts } from '@/hooks/useMacroAlerts'
import { usePortfolios } from '@/hooks/usePortfolios'
import { api, type PlaybookLens, type StoredStrategy } from '@/lib/api'
import { buildBoard, type Horizon } from '@/lib/macroBoard'
import { MAX_SERIES, daysBetween, formatIsoDate, todayIso } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'
import { GlobalAlertGlobe } from '@/components/macro/GlobalAlertGlobe'
import { GlobalAlertSummary } from '@/components/macro/GlobalAlertSummary'

const SECTIONS = [
  { id: 'verdict', label: 'Verdict' },
  { id: 'history', label: 'History' },
  { id: 'playbook', label: 'Playbook' },
  { id: 'board', label: 'Cross-asset' },
  { id: 'series', label: 'Series' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'linkage', label: 'Linkage' },
] as const

const RANGE_YEARS: Record<string, number> = { '1y': 1, '3y': 3, '5y': 5, '10y': 10, max: 0 }
const COMPARE_YEARS: Record<string, number> = { none: 0, '1y': 1, '3y': 3 }
const DEFAULT_SERIES = ['US10Y', 'VIX', 'DXY']
const DESK_REFRESH_MS = 2 * 60 * 60 * 1000 // refresh macro desk data every 2 hours

/**
 * What regime we are in, and what it has meant for markets.
 *
 * The page argues in order: the claim (verdict), whether it has been like this
 * (history), what it has paid (playbook), where the market is now (board), the
 * detail (series), what could change it (calendar), and what it does to your
 * book (linkage).
 *
 * There is no left rail. It listed the same 31 series the snapshot strip
 * showed as tiles, and two representations of identical data took most of the
 * viewport; the cross-asset board carries both roles now, and every control
 * lives in the header bar of the panel it governs rather than competing at the
 * top of the page.
 */
export function MacroDeskPage() {
  const [params, setParams] = useSearchParams()
  const paneRef = useRef<HTMLDivElement>(null)

  const [horizon, setHorizon] = useState<Horizon>('1d')
  const [mode, setMode] = useState<SeriesMode>('indexed')
  const [range, setRange] = useState('5y')
  const [compare, setCompare] = useState('1y')
  const [ribbonLens, setRibbonLens] = useState<RibbonLens>('quadrant')
  const [eventCountry, setEventCountry] = useState('US')
  const [indicatorCountry, setIndicatorCountry] = useState('USA')
  const [active, setActive] = useState<string>('verdict')
  const [strategies, setStrategies] = useState<StoredStrategy[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const { registry } = useMacroRegistry()
  const { snapshot, loading: snapshotLoading, refresh: refreshSnapshot } = useMacroSnapshot()
  const { regime, loading: regimeLoading, refresh: refreshRegime } = useMacroRegime()
  const { history, loading: historyLoading, refresh: refreshHistory } = useMacroRegimeHistory(24)
  const { portfolios, refresh: refreshPortfolios } = usePortfolios()
  const { alerts, loading: alertsLoading, refresh: refreshAlerts } = useMacroAlerts()

  // ── URL state ───────────────────────────────────────────────────────────
  const selected = useMemo(() => {
    const raw = params.get('series')
    const keys = raw !== null
      ? raw.split(',').map((k) => k.trim().toUpperCase()).filter(Boolean)
      : DEFAULT_SERIES
    const known = new Set((registry?.groups ?? []).flatMap((g) => g.series.map((s) => s.key)))
    return (registry ? keys.filter((k) => known.has(k)) : keys).slice(0, MAX_SERIES)
  }, [params, registry])

  const playbookLens = (params.get('playbook') ?? 'quadrant') as PlaybookLens
  const { playbook, loading: playbookLoading, refresh: refreshPlaybook } = useMacroPlaybook(playbookLens)

  const patch = useCallback((mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params)
    mutate(next)
    setParams(next, { replace: true })
  }, [params, setParams])

  const setSelected = useCallback((keys: string[]) => {
    patch((next) => next.set('series', keys.join(',')))
  }, [patch])

  // Scroll to the chart only when the selection goes empty -> one. Scrolling
  // on every toggle makes multi-select unusable; never scrolling makes the
  // first click look like it did nothing.
  const firstPick = useRef(false)
  const toggleSeries = useCallback((key: string) => {
    const at = selected.indexOf(key)
    if (at >= 0) {
      setSelected(selected.filter((k) => k !== key))
      return
    }
    if (selected.length >= MAX_SERIES) return
    if (selected.length === 0 && firstPick.current) {
      requestAnimationFrame(() =>
        document.getElementById('series')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
    firstPick.current = true
    setSelected([...selected, key])
  }, [selected, setSelected])

  useEffect(() => { firstPick.current = true }, [])

  const linkKind = (params.get('portfolio') ? 'portfolio' : 'strategy') as
    'strategy' | 'portfolio'
  const linkId = params.get('portfolio') ?? params.get('strategy')

  const setSubject = useCallback((kind: 'strategy' | 'portfolio', id: string | null) => {
    patch((next) => {
      next.delete('strategy')
      next.delete('portfolio')
      if (id) next.set(kind, id)
    })
  }, [patch])

  // ── Data ────────────────────────────────────────────────────────────────
  const start = useMemo(() => {
    const years = RANGE_YEARS[range] ?? 5
    return years ? `${new Date().getFullYear() - years}-01-01` : undefined
  }, [range])

  const compareDate = useMemo(() => {
    const years = COMPARE_YEARS[compare] ?? 0
    if (!years) return undefined
    const now = new Date()
    return `${now.getFullYear() - years}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  }, [compare])

  const { series, loading: seriesLoading, refresh: refreshSeries } = useMacroSeriesData(selected, start)
  const { curve, loading: curveLoading, refresh: refreshCurve } = useMacroCurve(compareDate)
  const { calendar, loading: calendarLoading, refresh: refreshCalendar } = useMacroCalendar(eventCountry)
  const { indicators, loading: indicatorsLoading, refresh: refreshIndicators } = useCountryIndicators(indicatorCountry)

  const board = useMemo(
    () => buildBoard(registry, snapshot, horizon), [registry, snapshot, horizon],
  )

  useEffect(() => {
    let cancelled = false
    void api.listStrategies()
      .then((r) => { if (!cancelled) setStrategies(r.strategies) })
      .catch(() => { if (!cancelled) setStrategies([]) })
    return () => { cancelled = true }
  }, [])

  // ── Auto-refresh ─────────────────────────────────────────────────────────
  // The macro desk can sit open for long periods; re-fetch the desk from the
  // API every two hours so new EODHD prints are visible. The actual EODHD pull
  // happens server-side on the same interval (see macro_auto_refresh.py), so
  // this poll just surfaces whatever the cache now holds.
  const refreshAll = useCallback(() => {
    void refreshSnapshot()
    void refreshRegime()
    void refreshHistory()
    void refreshPlaybook()
    void refreshCurve()
    void refreshCalendar()
    void refreshIndicators()
    void refreshSeries()
    void refreshAlerts()
    void refreshPortfolios()
    void api.listStrategies()
      .then((r) => { setStrategies(r.strategies) })
      .catch(() => { setStrategies([]) })
  }, [
    refreshSnapshot, refreshRegime, refreshHistory, refreshPlaybook,
    refreshCurve, refreshCalendar, refreshIndicators, refreshSeries,
    refreshAlerts, refreshPortfolios,
  ])

  useEffect(() => {
    const id = setInterval(refreshAll, DESK_REFRESH_MS)
    return () => clearInterval(id)
  }, [refreshAll])

  const pollMacroRefreshJob = async (jobId: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          const job = await api.macroRefreshJob(jobId)
          if (job.status === 'done') {
            resolve()
          } else if (job.status === 'error') {
            reject(new Error(job.error ?? 'Macro refresh failed'))
          } else {
            setTimeout(poll, 2000)
          }
        } catch (err) {
          reject(err)
        }
      }
      void poll()
    })
  }

  // Trigger a backend macro refresh and re-fetch the desk once it finishes.
  // This is admin-gated on the server; if the caller lacks permission we surface
  // a helpful message instead of a raw error. Routine freshness is handled by
  // the server's own 2-hour EODHD refresh.
  const runBackendRefresh = useCallback(async () => {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const { job_id: jobId } = await api.startMacroRefresh({ what: 'all' })
      await pollMacroRefreshJob(jobId)
      refreshAll()
    } catch (err) {
      const isAuth = err instanceof Error && /403|admin|permission/i.test(err.message)
      setRefreshError(
        isAuth
          ? 'Admin access required for on-demand refresh — data refreshes automatically every 2 hours.'
          : (err instanceof Error ? err.message : 'Refresh failed'),
      )
    } finally {
      setRefreshing(false)
    }
  }, [refreshAll])

  const staleDays = regime?.as_of ? daysBetween(regime.as_of, todayIso()) : 0

  // ── Scroll spy ──────────────────────────────────────────────────────────
  // The scroll container is the pane, not the document, so the observer has to
  // be rooted on it — a document-rooted observer never fires here. The section
  // list is a dependency because panels render conditionally, and resolving
  // ids once at mount would leave the later sections unobserved for ever.
  const sectionIds = SECTIONS.map((s) => s.id).join(',')
  useEffect(() => {
    const root = paneRef.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
        if (visible) setActive(visible.target.id)
      },
      { root, rootMargin: '-12% 0px -70% 0px', threshold: [0, 0.25, 0.5] },
    )
    for (const id of sectionIds.split(',')) {
      const node = document.getElementById(id)
      if (node) observer.observe(node)
    }
    return () => observer.disconnect()
  }, [sectionIds])

  // A deep-linked subject scrolls the linkage panel into view, but only once
  // the verdict has rendered — the sections above grow by several hundred
  // pixels when their data lands.
  const scrolled = useRef(false)
  useEffect(() => {
    if (!linkId || scrolled.current || !regime) return
    scrolled.current = true
    requestAnimationFrame(() =>
      document.getElementById('linkage')?.scrollIntoView({ block: 'start' }))
  }, [linkId, regime])

  return (
    <div ref={paneRef} className="min-h-0 flex-1 overflow-y-auto">
      <PageHeader
        title="Macro Desk"
        description="What regime we are in, and what it has meant for markets."
        actions={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            {regime?.as_of && (
              <>
                <span className="font-mono text-label text-muted-foreground">
                  as of {formatIsoDate(regime.as_of)}
                </span>
                {staleDays > 3 && (
                  <Badge variant="clay">{staleDays}d behind</Badge>
                )}
              </>
            )}
            <Button variant="outline" size="sm" onClick={runBackendRefresh} disabled={refreshing}>
              <RefreshCw className={cn('mr-1.5 h-3 w-3', refreshing && 'animate-spin')} />
              {refreshing ? 'Refreshing…' : 'Refresh data'}
            </Button>
            {refreshError && (
              <span className="max-w-[16rem] truncate text-micro text-destructive">
                {refreshError}
              </span>
            )}
          </div>
        )}
      />

      <div className="p-6 pt-0">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
          <main className="min-w-0 flex-1">
            <TabNav
              className="-mx-6 mb-4"
              tabs={SECTIONS.map((section) => ({ key: section.id as string, label: section.label }))}
              active={active}
              onChange={(id) => {
                setActive(id)
                document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            />

            <div className="space-y-8">
              <section id="verdict" className="scroll-mt-14">
                <RegimeVerdict regime={regime} loading={regimeLoading} />
              </section>

              <section id="history" className="scroll-mt-14">
                <RegimeRibbon
                  history={history}
                  lens={ribbonLens}
                  onLensChange={setRibbonLens}
                  loading={historyLoading}
                />
              </section>

              <section id="playbook" className="scroll-mt-14">
                <RegimePlaybook
                  playbook={playbook}
                  lens={playbookLens}
                  onLensChange={(lens) => patch((next) => next.set('playbook', lens))}
                  loading={playbookLoading}
                />
              </section>

              <section id="board" className="scroll-mt-14">
                <CrossAssetBoard
                  groups={board}
                  horizon={horizon}
                  onHorizonChange={setHorizon}
                  selected={selected}
                  onToggle={toggleSeries}
                  onClear={() => setSelected([])}
                  loading={snapshotLoading}
                />
              </section>

              <section id="series" className="scroll-mt-14">
                <SeriesExplorer
                  registry={registry}
                  series={series}
                  selected={selected}
                  onToggle={toggleSeries}
                  onClear={() => setSelected([])}
                  range={range}
                  onRangeChange={setRange}
                  mode={mode}
                  onModeChange={setMode}
                  compare={compare}
                  onCompareChange={setCompare}
                  curve={curve}
                  loadingSeries={seriesLoading}
                  loadingCurve={curveLoading}
                />
              </section>

              <section id="calendar" className="scroll-mt-14">
                <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
                  <Panel title="Economic calendar" hint="What could change the read">
                    <EconomicCalendar
                      calendar={calendar}
                      country={eventCountry}
                      onCountryChange={setEventCountry}
                      loading={calendarLoading}
                    />
                  </Panel>
                  <Panel title="Country indicators" hint="Annual, World Bank">
                    <CountryIndicatorPanel
                      data={indicators}
                      country={indicatorCountry}
                      onCountryChange={setIndicatorCountry}
                      loading={indicatorsLoading}
                    />
                  </Panel>
                </div>
              </section>

              <section id="linkage" className="scroll-mt-14 pb-10">
                <LinkagePanel
                  strategies={strategies}
                  portfolios={portfolios}
                  kind={linkKind}
                  subjectId={linkId}
                  onSubjectChange={setSubject}
                />
              </section>
            </div>
          </main>

          <aside className="hidden w-80 shrink-0 xl:block">
            <div className="sticky top-6 space-y-4">
              <GlobalAlertGlobe alerts={alerts} loading={alertsLoading} />
              <GlobalAlertSummary alerts={alerts} loading={alertsLoading} />
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
