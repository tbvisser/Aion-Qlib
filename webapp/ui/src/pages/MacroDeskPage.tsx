import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Panel } from '@/components/ui/panel'
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
import { usePortfolios } from '@/hooks/usePortfolios'
import { api, type PlaybookLens, type StoredStrategy } from '@/lib/api'
import { buildBoard, type Horizon } from '@/lib/macroBoard'
import { MAX_SERIES, daysBetween, formatIsoDate, todayIso } from '@/lib/macroFormat'
import { cn } from '@/lib/utils'

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

  const { registry } = useMacroRegistry()
  const { snapshot, loading: snapshotLoading } = useMacroSnapshot()
  const { regime, loading: regimeLoading } = useMacroRegime()
  const { history, loading: historyLoading } = useMacroRegimeHistory(24)
  const { portfolios } = usePortfolios()

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
  const { playbook, loading: playbookLoading } = useMacroPlaybook(playbookLens)

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

  const { series, loading: seriesLoading } = useMacroSeriesData(selected, start)
  const { curve, loading: curveLoading } = useMacroCurve(compareDate)
  const { calendar, loading: calendarLoading } = useMacroCalendar(eventCountry)
  const { indicators, loading: indicatorsLoading } = useCountryIndicators(indicatorCountry)

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

  const staleDays = regime?.as_of ? daysBetween(regime.as_of, todayIso()) : 0

  return (
    <div ref={paneRef} className="min-h-0 flex-1 overflow-y-auto">
      <PageHeader
        title="Macro Desk"
        description="What regime we are in, and what it has meant for markets."
        actions={regime?.as_of ? (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">
              as of {formatIsoDate(regime.as_of)}
            </span>
            {staleDays > 3 && (
              <span className="rounded bg-clay/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-clay">
                {staleDays}d behind
              </span>
            )}
          </div>
        ) : null}
      />

      <div className="p-6 pt-0">
        <div className="sticky top-0 z-20 -mx-6 mb-4 border-b border-border/50 bg-background/80 px-6 py-2 backdrop-blur">
          <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border/50 p-0.5">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => {
                  setActive(section.id)
                  document.getElementById(section.id)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
                className={cn(
                  'shrink-0 rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors',
                  active === section.id
                    ? 'bg-foreground/[0.07] text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {section.label}
              </button>
            ))}
          </div>
        </div>

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
      </div>
    </div>
  )
}
