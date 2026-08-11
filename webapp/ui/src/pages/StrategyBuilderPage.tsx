import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bot, FileCode2, Play, Save } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { AssistantDock } from '@/components/builder/AssistantDock'
import { BacktestsPanel } from '@/components/builder/BacktestsPanel'
import { CoverageBanner } from '@/components/builder/CoverageBanner'
import { StrategySummary } from '@/components/builder/StrategySummary'
import { RunDock, useRunDockOpen, useSessionRuns } from '@/components/builder/RunDock'
import { RunReportModal } from '@/components/runs/RunReportModal'
import { loadTemplates } from '@/hooks/useTemplates'
import { StartHere } from '@/components/builder/StartHere'
import { StrategyForm } from '@/components/builder/StrategyForm'
import { BuilderRail } from '@/components/canvas/BuilderRail'
import { FactorCanvas, type FeatureSetSnapshot } from '@/components/canvas/FactorCanvas'
import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { Segmented } from '@/components/ui/segmented'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { useHealth } from '@/hooks/useHealth'
import { useUniverseCount } from '@/hooks/useStoreUniverses'
import {
  DEFAULT_STRATEGY, api,
  type DataStore, type FeatureMode, type ModelsResponse, type Run,
  type StoredStrategy, type StrategyCoverage, type StrategyExplain, type StrategySpec,
} from '@/lib/api'
import { mergeBlockers } from '@/lib/blockers'
import { blocking, toSpecFeatures } from '@/lib/factorExpr/featureSet'

type Mode = 'form' | 'canvas'

export function StrategyBuilderPage() {
  const [params] = useSearchParams()
  const { health } = useHealth(0)
  // The Indicators page links in with ?mode=canvas&expression=..., so arriving
  // from a library row lands on the canvas with that expression already drawn
  // rather than on the form with a query string nothing reads.
  const handedOver = params.get('expression') ?? undefined
  const [mode, setMode] = useState<Mode>(
    params.get('mode') === 'canvas' || handedOver ? 'canvas' : 'form')
  const [assistantOpen, setAssistantOpen] = useState(false)
  /** The whole canvas state, lifted: the spec needs it and so does the assistant. */
  const [canvas, setCanvas] = useState<FeatureSetSnapshot | null>(null)
  /**
   * Bumped only when the spec is replaced wholesale — a saved strategy loaded,
   * an assistant proposal applied. That is the only signal the canvas accepts
   * for re-seeding, because diffing would fight it mid-edit.
   */
  const [specRevision, setSpecRevision] = useState(0)
  /**
   * Whether the front door has been sent away.
   *
   * It shows while `specRevision === 0` — that counter is bumped by
   * `applySpec` and `openSaved` and by nothing else, so zero already means
   * "nothing has been loaded into this builder yet". This flag covers the other
   * exit: someone who ignores both offers and edits the form directly, and
   * should not have to keep scrolling past a panel they have declined.
   */
  const [startHereGone, setStartHereGone] = useState(false)
  const [spec, setSpec] = useState<StrategySpec>(DEFAULT_STRATEGY)
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [stores, setStores] = useState<DataStore[]>([])
  const [saved, setSaved] = useState<StoredStrategy[]>([])
  const [currentId, setCurrentId] = useState<string | undefined>()
  const [yamlText, setYamlText] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  /** Advisory store facts from the same preview call. Never a blocker. */
  const [coverage, setCoverage] = useState<StrategyCoverage | undefined>()
  /** The prediction target and the store's real date range, from the same call. */
  const [explain, setExplain] = useState<StrategyExplain | undefined>()
  /** So the summary can say "the 500 names in top500" rather than a bare slug. */
  const universeCount = useUniverseCount(spec.data_store, spec.universe)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Runs launched from this session, and whether their panel is expanded. */
  const sessionRuns = useSessionRuns()
  const [runDockOpen, setRunDockOpen] = useRunDockOpen()
  /**
   * Every run, fetched once and shared.
   *
   * The dock needs it to fall back to a saved strategy's newest run and the
   * backtest index needs it to be an index; two components fetching the same
   * list would let them disagree about what exists.
   */
  const [runs, setRuns] = useState<Run[]>([])
  const [reportRun, setReportRun] = useState<Run | null>(null)

  const refreshRuns = useCallback(async () => {
    try {
      // Explicit, because the server's default is 100 and says nothing about
      // it — a strategy iterated on for an afternoon reaches that, and the
      // ledger then stops showing the early attempts it exists to compare.
      setRuns((await api.listRuns(500)).runs)
    } catch {
      /* the index is a convenience; a failure must not disturb the builder */
    }
  }, [])

  useEffect(() => {
    api.models().then(setModels).catch(() => undefined)
    void refreshSaved()
    void refreshRuns()
    // Warmed here rather than on first paint of the rail. Lowering thirty
    // templates against this machine is slow enough to be visible, and the
    // templates half of the rail is one click away in either mode.
    void loadTemplates().catch(() => undefined)
  }, [])

  /**
   * Replace the whole spec with one offered from elsewhere.
   *
   * Three things, and all three matter: the spec itself, clearing the saved id
   * because an offered strategy is not the saved one, and bumping the revision —
   * the only signal `FactorCanvas` accepts for re-seeding, and therefore the only
   * reason a template carrying feature columns draws them.
   */
  const applySpec = useCallback((next: StrategySpec) => {
    setSpec(next)
    setCurrentId(undefined)
    setSpecRevision((r) => r + 1)
  }, [])

  /**
   * Open a saved strategy from the rail.
   *
   * Same three steps as `applySpec` except the id is *kept*: this is the saved
   * strategy, so Save must update it rather than fork a second copy.
   */
  const openSaved = useCallback((s: StoredStrategy) => {
    setSpec(s)
    setCurrentId(s.id)
    setSpecRevision((r) => r + 1)
  }, [])

  /**
   * Delete a saved strategy.
   *
   * If it is the one currently open, the editor keeps its contents and simply
   * forgets the id — the work in front of you is not destroyed by deleting the
   * record, and the next Save writes a new one.
   */
  const deleteSaved = useCallback(async (s: StoredStrategy) => {
    try {
      await api.deleteStrategy(s.id)
      setCurrentId((id) => (id === s.id ? undefined : id))
      await refreshSaved()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete')
    }
  }, [])

  const refreshSaved = async () => {
    try {
      setSaved((await api.listStrategies()).strategies)
    } catch {
      /* the list is a convenience; a failure here must not block building */
    }
  }

  // Keep the YAML preview honest: it is regenerated by the backend from the
  // same function that produces the config qrun actually runs.
  //
  // This effect lives above the mode switch on purpose. The toggle changes what
  // is rendered, never where state lives, so the preview is identical in both
  // modes and cannot drift into a client-side approximation in one of them.
  const preview = useCallback(async () => {
    try {
      const r = await api.previewStrategy(spec)
      setYamlText(r.yaml)
      setWarnings(r.warnings)
      setCoverage(r.coverage)
      setExplain(r.explain)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed')
    }
  }, [spec])

  useEffect(() => {
    const t = setTimeout(() => void preview(), 300)
    return () => clearTimeout(t)
  }, [preview])

  const save = async () => {
    setBusy(true)
    try {
      const stored = await api.saveStrategy(spec, currentId)
      setCurrentId(stored.id)
      await refreshSaved()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  // Starting a backtest used to navigate to /runs/<id>, which threw the canvas
  // away at the moment you most wanted it. The run now streams into the dock
  // below and the builder stays exactly where it was.
  const run = async () => {
    setBusy(true)
    try {
      const started = await api.startRun(spec, currentId)
      sessionRuns.add(started)
      setRunDockOpen(true)
      void refreshRuns()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start run')
    } finally {
      setBusy(false)
    }
  }

  // Universes come from the selected store, not the mounted one: a run targets
  // whichever store its spec names, and the two hold different instrument sets.
  const store = stores.find((s) => s.key === spec.data_store)
  const refreshStores = useCallback(async () => {
    try {
      const r = await api.dataStores()
      setStores(r.stores)
      // Replace the placeholder end date with the store's real one, once and
      // only for an untouched spec. `DEFAULT_STRATEGY.test_end` is a literal
      // that goes stale the next time an ingest extends the calendar, and a
      // stale one makes the backend clamp and warn on every fresh strategy.
      const end = r.stores.find((s) => s.key === DEFAULT_STRATEGY.data_store)?.calendar_end
      if (end) {
        setSpec((prev) => (prev.test_end === DEFAULT_STRATEGY.test_end
          ? { ...prev, test_end: end } : prev))
      }
    } catch {
      setStores([])
    }
  }, [])
  useEffect(() => { void refreshStores() }, [refreshStores])

  const universes = (store?.universes ?? health?.qlib.universes ?? [])
    .filter((u) => u !== 'benchmarks')

  // The canvas owns the feature set; the spec receives only the finished
  // columns. An unfinished tree serialises with a `?` in it, which would 422
  // the debounced preview on every keystroke and paint the page red while the
  // user is still building.
  useEffect(() => {
    if (!canvas) return
    const features = toSpecFeatures(canvas.features)
    setSpec((prev) => {
      const next = features.length ? features : null
      return JSON.stringify(prev.features) === JSON.stringify(next)
        ? prev : { ...prev, features: next }
    })
  }, [canvas])

  const featureErrors = blocking(canvas?.issues ?? [])
  const unfinished = (canvas?.features ?? []).filter((f) => !f.complete)

  // The client and the server check the same feature rules, on purpose: the
  // client so the message lands while the name is being typed, the server
  // because it is the authority and cannot be bypassed. That means both report
  // a collision, in near-identical words, at the same moment.
  //
  // One list, nothing said twice. The rules and the reasons for them live in
  // `lib/blockers`, where a test can hold them: this used to be inline, and the
  // live server-validation wiring quietly made the old rule insufficient.
  const blockers = mergeBlockers(warnings, featureErrors.map((i) => ({
    message: i.message,
    columnName: canvas?.features.find((f) => f.id === i.columnId)?.name,
  })))

  return (
    <>
      <PageHeader
        title="Strategy Builder"
        // The name is the title. It used to be editable only in form mode, so
        // anyone working on the canvas — where the Indicators page drops you —
        // ran everything as "New strategy", and the backtest index, /runs and
        // the rail all filled with identical rows.
        titleSlot={
          <div className="flex min-w-0 items-baseline gap-2">
            <input
              data-testid="strategy-name"
              value={spec.name}
              onChange={(e) => setSpec((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="Name this strategy"
              aria-label="Strategy name"
              className="min-w-0 max-w-md flex-1 truncate rounded-md bg-transparent px-1.5 py-0.5 text-lg font-semibold tracking-tight outline-none transition-colors placeholder:font-normal placeholder:text-muted-foreground/60 hover:bg-foreground/[0.04] focus:bg-foreground/[0.06]"
            />
            {currentId && (
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                saved
              </span>
            )}
          </div>
        }
        // What this page is *for*, and what the page next door is for. The
        // division only helps if it is stated where the reader is standing —
        // and the old sentence ("Pick a model, a universe and a period") named
        // the model first, which is the framing this page is moving away from.
        description={mode === 'form'
          ? 'Describe a strategy, or start from a card. Trains one model here; sweep several in ML Studio.'
          : 'Compose a factor expression as cards. The string at the bottom is what qlib evaluates.'}
        actions={
          <>
            <ModeToggle value={mode} onChange={setMode} />
            <Button
              variant={assistantOpen ? 'secondary' : 'outline'}
              size="sm"
              data-testid="assistant-toggle"
              onClick={() => setAssistantOpen((o) => !o)}
            >
              <Bot className="h-4 w-4" />
              Assistant
            </Button>
            {/* Both modes now. The YAML used to be a permanent column in form
                mode, standing where the explanation should be; behind this
                button it is still exactly one click away in either mode. */}
            <YamlDialog yaml={yamlText} />
            <Button variant="outline" size="sm" onClick={() => void save()} disabled={busy}>
              <Save className="h-4 w-4" />
              {currentId ? 'Update' : 'Save'}
            </Button>
            {/* The reason travels with the button. It lives in `Alerts` too,
                but in form mode that is the top of a scrollable column while
                this is in a fixed header — so editing a date low down greyed
                out the primary action with the explanation off-screen. */}
            <Button
              size="sm"
              onClick={() => void run()}
              disabled={busy || blockers.length > 0}
              title={blockers.length
                ? blockers.join('\n')
                : 'Train the model and backtest it — usually a few minutes'}
            >
              <Play className="h-4 w-4" />
              Run backtest
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* The mode content and the run dock share a column, so the dock spans the
          canvas in both modes and the assistant keeps its full-height rail. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {mode === 'form' ? (
        // The rail is mounted here too. Its blocks half needs a canvas and says
        // so, but templates and saved strategies are how you start in either
        // mode — and the form used to be the only place your saved work showed.
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <BuilderRail
            canInsert={false}
            saved={saved}
            currentId={currentId}
            onUseTemplate={applySpec}
            onOpenSaved={openSaved}
            onDeleteSaved={deleteSaved}
          />

          {/* No backtest index here: form mode is two full columns wide and a
              floating panel lands on top of the YAML preview. The run dock
              still follows a run started from this mode. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="mx-auto grid max-w-7xl gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
              <div className="space-y-6">
                <Alerts error={error} warnings={blockers} unfinished={unfinished.length} coverage={coverage} />
                {/* Form mode only. Canvas mode is where the Indicators page
                    drops you with an expression already drawn — offering to
                    help you start is answering a question you have answered. */}
                {specRevision === 0 && !startHereGone && (
                  <StartHere
                    spec={spec}
                    onApply={applySpec}
                    onDismiss={() => setStartHereGone(true)}
                  />
                )}
                <StrategyForm
                  spec={spec}
                  setSpec={setSpec}
                  models={models}
                  stores={stores}
                  store={store}
                  universes={universes}
                  onStoresChanged={() => void refreshStores()}
                />
              </div>

              {/* The lead explanation. This column used to hold a hundred
                  lines of qrun YAML, which is precise and answers none of the
                  questions a reader actually has — starting with what the
                  thing predicts, which appeared nowhere in the UI at all. */}
              <div className="xl:sticky xl:top-6 xl:self-start">
                <StrategySummary
                  spec={spec}
                  explain={explain}
                  universeCount={universeCount}
                  coverage={coverage}
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {(error || blockers.length > 0 || unfinished.length > 0 || coverage) && (
            <div className="space-y-2 border-b border-border/50 px-6 py-3">
              <Alerts error={error} warnings={blockers} unfinished={unfinished.length} coverage={coverage} />
            </div>
          )}
          <FactorCanvas
            initialFeatures={spec.features}
            revision={specRevision}
            handler={spec.handler}
            store={spec.data_store}
            measure={{
              universe: spec.universe,
              // The *test* window. Measuring on the training period reports
              // what the model is about to memorise, not what it can predict.
              testStart: spec.test_start,
              testEnd: explain?.effective_test_end ?? spec.test_end,
              store: spec.data_store,
              mountedStore: stores.find((s) => s.mounted)?.key,
            }}
            mode={spec.feature_mode}
            onModeChange={(feature_mode: FeatureMode) =>
              setSpec((prev) => ({ ...prev, feature_mode }))}
            onChange={setCanvas}
            openExpression={handedOver}
            openName={params.get('name') ?? undefined}
            saved={saved}
            currentId={currentId}
            onUseTemplate={applySpec}
            onOpenSaved={openSaved}
            onDeleteSaved={deleteSaved}
            overlay={<BacktestsPanel runs={runs} onOpenReport={setReportRun} />}
          />
        </div>
      )}

        <RunDock
          runs={runs}
          strategyId={currentId}
          sessionRunIds={sessionRuns.ids}
          seedRun={sessionRuns.seed}
          onFinish={refreshRuns}
          open={runDockOpen}
          onOpenChange={setRunDockOpen}
        />
      </div>

      {assistantOpen && (
        <AssistantDock
          spec={spec}
          strategyId={currentId}
          mode={mode}
          expression={canvas?.active}
          features={canvas?.features}
          featureMode={spec.feature_mode}
          // The assistant's only route into the form, and the same three steps
          // the template gallery takes. The debounced preview effect above turns
          // either into fresh server-rendered YAML for free.
          onApply={applySpec}
          onClose={() => setAssistantOpen(false)}
        />
      )}
      </div>

      <RunReportModal run={reportRun} onClose={() => setReportRun(null)} />
    </>
  )
}

/**
 * `Segmented` is the app's mode switch, and this was one of the four copies it
 * was extracted from — it just never got migrated. Using it brings the roving
 * arrow keys and radiogroup semantics the hand-rolled version never had.
 */
function ModeToggle({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  return (
    <Segmented
      value={value}
      onChange={onChange}
      options={[
        { value: 'form', label: 'Form', testId: 'builder-mode-form',
          title: 'The whole spec as labelled controls' },
        { value: 'canvas', label: 'Canvas', testId: 'builder-mode-canvas',
          title: 'Compose a factor expression as cards' },
      ]}
    />
  )
}

/**
 * In canvas mode the YAML has no column to sit in, so it moves behind a button
 * rather than disappearing -- what runs must stay one click away in both modes.
 */
function YamlDialog({ yaml }: { yaml: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FileCode2 className="h-4 w-4" />
          Config
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Generated workflow config</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[65vh] overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11px] leading-relaxed">
          {yaml || 'Building preview…'}
        </pre>
        <p className="text-[11px] text-muted-foreground">
          This exact file is handed to <span className="font-mono">qrun</span>. Running it
          from a terminal produces the same result as the Run button.
        </p>
      </DialogContent>
    </Dialog>
  )
}

function Alerts({ error, warnings, unfinished = 0, coverage }: {
  error: string | null
  warnings: string[]
  /** Columns still being built. Not errors — they are simply not in the config. */
  unfinished?: number
  /** Store facts. Advisory: rendered last, and never gates the Run button. */
  coverage?: StrategyCoverage
}) {
  return (
    <>
      {error && <Notice tone="destructive" icon={false}>{error}</Notice>}

      {unfinished > 0 && (
        <Notice tone="muted">
          {unfinished} {unfinished === 1 ? 'feature is' : 'features are'} unfinished and
          not in the config yet. Fill the empty slots, or delete the column.
        </Notice>
      )}

      {warnings.length > 0 && (
        <Notice tone="clay">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </Notice>
      )}

      <CoverageBanner coverage={coverage} />
    </>
  )
}
