/**
 * The Strategy Builder.
 *
 * The whole strategy is a chain of eight stage cards on a canvas; clicking one
 * opens its fields in the right rail. That replaces a `form | canvas` toggle
 * where the form was a long column of controls and the canvas only ever held
 * factor expressions -- so nothing on screen ever showed the strategy as a
 * whole, which is the one thing a builder ought to show.
 *
 * Two panes share the canvas area: the pipeline, and the factor canvas reached
 * from the Features stage. **Both are mounted at all times**; the inactive one
 * is `invisible pointer-events-none`, never unmounted. That is load-bearing --
 * see the docblock on `BuilderPanes`, which owns the invariant.
 *
 * This file is the composition: state, the wiring between it, and the layout.
 * The heavier machinery lives beside it — the debounced server preview in
 * `useStrategyPreview`, the run ledger in `useRuns`, and the
 * canvas-issues → routing → badges chain in `lib/strategyGraph/deriveStatus`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Bot, Play } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { AssistantDock } from '@/components/builder/AssistantDock'
import { BacktestsPanel, useBacktestsOpen } from '@/components/builder/BacktestsPanel'
import { BuilderPanes, type Pane } from '@/components/builder/BuilderPanes'
import { RunConfirmDialog } from '@/components/builder/RunConfirmDialog'
import { RunReportModal } from '@/components/runs/RunReportModal'
import { loadTemplates } from '@/hooks/useTemplates'
import { StartHere } from '@/components/builder/StartHere'
import { StrategyImport } from '@/components/builder/StrategyImport'
import { StrategyMenu } from '@/components/builder/StrategyMenu'
import { UnsavedChangesDialog } from '@/components/builder/UnsavedChangesDialog'
import { YamlDialog } from '@/components/builder/YamlDialog'
import { BuilderRail } from '@/components/canvas/BuilderRail'
import { FactorCanvas, type FeatureSetSnapshot } from '@/components/canvas/FactorCanvas'
import { PipelineCanvas } from '@/components/pipeline/PipelineCanvas'
import { COMPAT_FIELDS } from '@/components/pipeline/inspectors/compat'
import { StageInspector } from '@/components/pipeline/StageInspector'
import { StageStrip } from '@/components/pipeline/StageStrip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { useBuilderChat, useChatConfigured } from '@/hooks/useBuilderChat'
import { useRuns } from '@/hooks/useRuns'
import { isActive } from '@/hooks/useRunStream'
import { useSessionRuns } from '@/hooks/useSessionRuns'
import { useStrategies } from '@/hooks/useStrategies'
import { useUniverseCount } from '@/hooks/useStoreUniverses'
import { useStrategyPreview } from '@/hooks/useStrategyPreview'
import { useBeforeUnloadWarning, useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  DEFAULT_STRATEGY, api,
  type DataStore, type FeatureMode, type ModelsResponse, type Run,
  type StoredStrategy, type StrategySpec,
} from '@/lib/api'
import { toSpecFeatures } from '@/lib/factorExpr/featureSet'
import { dirtyFields } from '@/lib/strategyDirty'
import { nextCopyName } from '@/lib/strategyNames'
import { applyStore } from '@/lib/storeSwitch'
import { deriveStatus, stageBlockingMessages } from '@/lib/strategyGraph/deriveStatus'
import { firstBlockedStage } from '@/lib/strategyGraph/stageStatus'
import type { StageId } from '@/lib/strategyGraph/stages'

export function StrategyBuilderPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  // The Indicators page links in with ?mode=canvas&expression=..., so arriving
  // from a library row lands on the factor canvas with that expression already
  // drawn. The param spelling is that page's; only the internal name changed.
  const handedOver = params.get('expression') ?? undefined
  const [pane, setPane] = useState<Pane>(
    params.get('mode') === 'canvas' || handedOver ? 'features' : 'pipeline')
  const [assistantOpen, setAssistantOpen] = useState(false)
  /** The stage card whose fields the inspector is showing. null = the summary. */
  const [selectedStage, setSelectedStage] = useState<StageId | null>(null)
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
   * exit: someone who ignores both offers and edits directly, and should not
   * have to keep dismissing a panel they have declined.
   */
  const [startHereGone, setStartHereGone] = useState(false)
  const [spec, setSpec] = useState<StrategySpec>(DEFAULT_STRATEGY)
  /**
   * The spec as it was the last time it agreed with the world.
   *
   * Set at four funnels and nowhere else: the `test_end` calendar patch below,
   * `applySpec`, `openSaved`, and a successful save. Dirtiness is a comparison
   * against this rather than a counter, because `setSpec` fires twice on load
   * without a user touching anything — the canvas sync and that calendar patch
   * — and a counter would call a freshly opened builder dirty within 300ms.
   */
  const [baseline, setBaseline] = useState<StrategySpec>(DEFAULT_STRATEGY)
  const [models, setModels] = useState<ModelsResponse | null>(null)
  const [stores, setStores] = useState<DataStore[]>([])
  const {
    saved, save: writeStrategy, remove: removeStrategy,
    setVisibility: setStrategyVisibility,
  } = useStrategies()
  const [currentId, setCurrentId] = useState<string | undefined>()
  /** Bumped to send the rail to its templates half. */
  const [templatesNonce, setTemplatesNonce] = useState(0)
  const [runConfirmOpen, setRunConfirmOpen] = useState(false)
  /** So the summary can say "the 500 names in top500" rather than a bare slug. */
  const universeCount = useUniverseCount(spec.data_store, spec.universe)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The server's whole answer to the current spec, 300ms behind the keyboard. */
  const preview = useStrategyPreview(spec)
  /** Runs launched from this session, and whether their panel is expanded. */
  const sessionRuns = useSessionRuns()
  const [backtestsOpen, setBacktestsOpen] = useBacktestsOpen()
  /** Every run, fetched once and shared with the backtests panel. */
  const { runs, refresh: refreshRuns, remove: deleteRun } = useRuns(setError)
  const [reportRun, setReportRun] = useState<Run | null>(null)

  useEffect(() => {
    api.models().then(setModels).catch(() => undefined)
    // Warmed here rather than on first paint of the rail. Lowering thirty
    // templates against this machine is slow enough to be visible, and the
    // templates half of the rail is one click away in either pane.
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
  const applySpecNow = useCallback((next: StrategySpec) => {
    setSpec(next)
    setBaseline(next)
    setCurrentId(undefined)
    setSpecRevision((r) => r + 1)
  }, [])

  /**
   * Open a saved strategy from the rail.
   *
   * Same three steps as `applySpec` except the id is *kept*: this is the saved
   * strategy, so Save must update it rather than fork a second copy.
   */
  const openSavedNow = useCallback((s: StoredStrategy) => {
    setSpec(s)
    setBaseline(s)
    setCurrentId(s.id)
    setSpecRevision((r) => r + 1)
  }, [])

  /**
   * Unsaved edits, and the guard around losing them.
   *
   * `applySpec` and `openSaved` are the only two ways the spec is replaced
   * wholesale, so wrapping *them* covers the template rail, the factor
   * canvas's copy of it, the front door, the assistant's Apply and the header
   * menu at once. Guarding the menu alone would leave four unguarded routes
   * into the same destruction.
   */
  const changed = useMemo(() => dirtyFields(spec, baseline), [spec, baseline])
  const dirty = changed.length > 0
  const { guard, pending, discard, cancel, resume } = useUnsavedGuard(dirty)
  useBeforeUnloadWarning(dirty)

  const applySpec = useCallback((next: StrategySpec) => {
    guard({ label: `open “${next.name}”`, run: () => applySpecNow(next) })
  }, [guard, applySpecNow])

  const openSaved = useCallback((s: StoredStrategy) => {
    guard({ label: `open “${s.name}”`, run: () => openSavedNow(s) })
  }, [guard, openSavedNow])

  // A deep link from /strategies/:id opens the referenced saved strategy once.
  const openedFromUrl = useRef(false)
  useEffect(() => {
    if (openedFromUrl.current) return
    const id = params.get('strategy')
    if (!id) return
    const s = saved.find((x) => x.id === id)
    if (!s) return
    openedFromUrl.current = true
    openSavedNow(s)
  }, [params, saved, openSavedNow])

  /**
   * Delete a saved strategy.
   *
   * If it is the one currently open, the editor keeps its contents and simply
   * forgets the id — the work in front of you is not destroyed by deleting the
   * record, and the next Save writes a new one.
   */
  const deleteSaved = useCallback(async (s: StoredStrategy) => {
    try {
      await removeStrategy(s.id)
      setCurrentId((id) => (id === s.id ? undefined : id))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete')
    }
  }, [removeStrategy])

  /** Returns whether it worked, so "Save and continue" knows not to continue. */
  const save = async (): Promise<boolean> => {
    setBusy(true)
    try {
      const stored = await writeStrategy(spec, currentId)
      setCurrentId(stored.id)
      // The record the server returned, not the spec we sent: it carries the
      // ids and timestamps, and comparing against the sent version would leave
      // the dot dirty the instant a save succeeded.
      setBaseline(stored)
      setError(null)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  /** Fork the current edits into a new, unsaved strategy. Nothing is lost, so no guard. */
  const duplicate = useCallback(() => {
    const name = nextCopyName(spec.name, saved.map((s) => s.name))
    applySpecNow({ ...spec, name })
  }, [spec, saved, applySpecNow])

  // Starting a backtest used to navigate to /runs/<id>, which threw the canvas
  // away at the moment you most wanted it. The run now streams into the
  // backtests panel and the builder stays exactly where it was.
  const start = async (draft: StrategySpec) => {
    setBusy(true)
    try {
      // The draft is committed to the spec, not merged behind its back — see
      // the docblock on `RunConfirmDialog`.
      setSpec(draft)
      const started = await api.startRun(draft, currentId)
      sessionRuns.add(started)
      setBacktestsOpen(true)
      // Closed before the panel's first paint: a Radix overlay is z-50 and
      // would sit over the panel's z-20 for a frame.
      setRunConfirmOpen(false)
      void refreshRuns()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start run')
    } finally {
      setBusy(false)
    }
  }

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
        // The baseline moves with it. This patch is the store answering a
        // question, not the user editing anything, and leaving the baseline
        // behind would make every freshly opened builder read "unsaved edits"
        // within 300ms — which is how a save indicator becomes noise.
        setSpec((prev) => (prev.test_end === DEFAULT_STRATEGY.test_end
          ? { ...prev, test_end: end } : prev))
        setBaseline((prev) => (prev.test_end === DEFAULT_STRATEGY.test_end
          ? { ...prev, test_end: end } : prev))
      }
    } catch {
      setStores([])
    }
  }, [])
  useEffect(() => { void refreshStores() }, [refreshStores])

  // The canvas owns the feature set; the spec receives only the finished
  // columns. An unfinished tree serialises with a `?` in it, which would 422
  // the debounced preview on every keystroke and paint the page red while the
  // user is still building.
  useEffect(() => {
    if (!canvas) return
    // Unparseable saved columns ride along untouched — the canvas cannot draw
    // them, but dropping them here is what would let a save delete them.
    const features = [...toSpecFeatures(canvas.features), ...canvas.unparsed]
    setSpec((prev) => {
      const next = features.length ? features : null
      // The mode follows the last column out. The server normalises `[]` to
      // null and refuses `replace` with nothing to replace, so leaving the
      // mode behind made every preview 422 — while the Extend/Replace
      // control, rendered only when columns exist, had already left the
      // screen and taken the way out with it.
      const feature_mode = next === null ? 'extend' : prev.feature_mode
      return JSON.stringify(prev.features) === JSON.stringify(next)
        && prev.feature_mode === feature_mode
        ? prev
        : { ...prev, features: next, feature_mode }
    })
  }, [canvas])

  /**
   * Canvas issues → merge with the preview's answer → route to stages → fold
   * into badges. The chain and its reasons live in
   * `lib/strategyGraph/deriveStatus`, where a test can hold the composition.
   */
  const derived = useMemo(
    () => deriveStatus({
      features: canvas?.features ?? [],
      issues: canvas?.issues ?? [],
      defects: preview.defects,
      warnings: preview.warnings,
      coverage: preview.coverage,
    }),
    [canvas, preview.defects, preview.warnings, preview.coverage])
  const { routed, blockers, status, unrouted, unfinished } = derived

  /** What the inspector prints at the top of its rail for the selected stage. */
  const stageBlocking = useMemo(
    () => stageBlockingMessages(routed, selectedStage, COMPAT_FIELDS),
    [routed, selectedStage])

  // One object per change, not one per render: `PipelineCanvas` memoizes its
  // nodes on this, and a fresh literal every render rebuilt every stage card's
  // data on every keystroke in an inspector.
  const glance = useMemo(() => ({
    store: stores.find((s) => s.key === spec.data_store),
    explain: preview.explain,
    models,
    universeCount,
    unfinished: unfinished.length,
  }), [stores, spec.data_store, preview.explain, models, universeCount, unfinished.length])

  /**
   * Take one of a field's resolutions.
   *
   * Routed through `applyStore` when the patch moves the store, because that
   * one is a cascade rather than an assignment: setting `data_store` alone
   * leaves the universe, the benchmark and the end date pointing at the store
   * it just left, which trades one blocker for three.
   */
  const applyPatch = useCallback((patch: Record<string, unknown>) => {
    setSpec((prev) => {
      const next = { ...prev, ...patch } as StrategySpec
      return typeof patch.data_store === 'string'
        ? applyStore(next, stores, patch.data_store)
        : next
    })
  }, [stores])

  const openFeatureCanvas = useCallback(() => setPane('features'), [])

  /**
   * One conversation, two views of it.
   *
   * Owned here rather than by either surface because the front door unmounts
   * the moment a proposal is applied — and when it owned the stream, that took
   * the transcript with it. Describing a strategy and using it now leaves the
   * history intact in the dock, so the next thing you say can be "make it lower
   * turnover" rather than starting over.
   */
  const configured = useChatConfigured()
  const chat = useBuilderChat({
    spec,
    strategyId: currentId,
    // `BuilderContext.mode` is a `Literal["form","canvas"]` under
    // `extra="forbid"` in api/chat_tools.py, so an unknown value 422s the chat
    // endpoint. Mapped at the boundary rather than widened there: what the
    // assistant needs to know is whether it is being asked about an expression
    // or about the spec, which is exactly the distinction the two panes draw.
    mode: pane === 'features' ? 'canvas' : 'form',
    expression: canvas?.active,
    features: canvas?.features,
    featureMode: spec.feature_mode,
  })

  /** Applying from the front door closes it and hands the conversation to the dock. */
  const applyFromFrontDoor = useCallback((next: StrategySpec) => {
    applySpec(next)
    setStartHereGone(true)
    setAssistantOpen(true)
  }, [applySpec])

  return (
    <>
      <PageHeader
        title="Pipeline Builder"
        // The name is the title. It used to be editable only in form mode, so
        // anyone working on the canvas — where the Indicators page drops you —
        // ran everything as "New strategy", and the backtest index, /runs and
        // the rail all filled with identical rows.
        titleSlot={
          <StrategyMenu
            name={spec.name}
            onNameChange={(name) => setSpec((prev) => ({ ...prev, name }))}
            currentId={currentId}
            dirty={dirty}
            changed={changed}
            saved={saved}
            busy={busy}
            onSave={() => void save()}
            onOpen={openSaved}
            onNew={() => applySpec(DEFAULT_STRATEGY)}
            onDuplicate={duplicate}
            onDelete={(s) => void deleteSaved(s)}
            onSetVisibility={(s, v) => {
              // `setVisibility` rethrows so callers can react; without a catch
              // a failed share was an unhandled rejection and said nothing.
              setStrategyVisibility(s.id, v).catch((e: unknown) => {
                setError(e instanceof Error ? e.message : 'Could not change visibility')
              })
            }}
            onBrowseTemplates={() => {
              setPane('pipeline')
              setTemplatesNonce((n) => n + 1)
            }}
          />
        }
        description={pane === 'pipeline'
          ? 'Click a stage to edit it. Trains one model here; sweep several in ML Studio.'
          : 'Compose a factor expression as cards. The string at the bottom is what qlib evaluates.'}
        actions={
          <>
            {/* The count is clickable and selects the first stage carrying a
                blocker. Removing the wall of warnings must not remove the way
                to find one: this is the header valve, the strip dots are the
                always-visible one, and the badges are on the cards themselves. */}
            {blockers.length > 0 && (
              <button
                type="button"
                data-testid="blocker-chip"
                title={blockers.join('\n')}
                onClick={() => {
                  const first = firstBlockedStage(status)
                  if (first) { setPane('pipeline'); setSelectedStage(first) }
                }}
              >
                <Badge variant="clay">
                  {blockers.length} blocking
                </Badge>
              </button>
            )}
            <Button
              variant={assistantOpen ? 'secondary' : 'outline'}
              size="sm"
              data-testid="assistant-toggle"
              onClick={() => setAssistantOpen((o) => !o)}
            >
              <Bot className="h-4 w-4" />
              Assistant
            </Button>
            {/* Beside the YAML view on purpose: that dialog is the way a
                strategy leaves this app, and until now there was no way back.
                Goes through `applySpec`, so it inherits the unsaved-changes
                guard rather than being a fifth route around it. */}
            <StrategyImport onApply={applySpec} />
            <YamlDialog yaml={preview.yaml} />
            {/* Save is in the strategy menu, not here. There is no reason to
                save a strategy before you know whether it worked, and a Save
                button beside Test strategy invited exactly that order. The
                unsaved dot still reports edits, and the unsaved-changes guard
                still offers "Save and continue". */}
            {/* Opens the confirm dialog rather than launching, and is disabled
                only while busy. A button whose sole explanation is a `title`
                is unreachable by keyboard and invisible on touch; the reasons
                are written in the dialog now, so it has to be able to open it. */}
            <Button
              size="sm"
              onClick={() => setRunConfirmOpen(true)}
              disabled={busy}
              title="Train the model and backtest it — usually a few minutes"
            >
              <Play className="h-4 w-4" />
              Test strategy
            </Button>
          </>
        }
      />

      <div className="border-b border-border/50 bg-clay/10 px-4 py-2">
        <Notice tone="clay" icon={false}>
          This builder is being replaced by the new{' '}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => navigate('/lab/keycards/new')}
          >
            Strategy Builder
          </button>
          . Save your strategies there to keep the new workflow features.
        </Notice>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* The pane content and the run dock share a column, so the dock spans
            the canvas in both panes and the assistant keeps its full-height rail. */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <StageStrip
            pane={pane}
            onBackToPipeline={() => setPane('pipeline')}
            // Which column, not just which stage. The factor canvas is the one
            // place in the builder you are two levels down, and the tab strip
            // that says which column is inside the pane the crumb sits above.
            activeColumn={canvas?.activeName}
          />

          {(error ?? preview.error) && (
            <div className="border-b border-border/50 px-6 py-2">
              <Notice tone="destructive" icon={false}>{error ?? preview.error}</Notice>
            </div>
          )}
          {unrouted.length > 0 && (
            <div className="border-b border-border/50 px-6 py-2">
              <Notice tone="clay">
                {unrouted.map((w) => <p key={w}>{w}</p>)}
              </Notice>
            </div>
          )}

          <BuilderPanes
            pane={pane}
            pipeline={
              <>
                {/* The rail's blocks half needs a canvas and says so, but
                    templates and saved strategies are how you start in either pane. */}
                <BuilderRail
                  canInsert={false}
                  saved={saved}
                  currentId={currentId}
                  onUseTemplate={applySpec}
                  onOpenSaved={openSaved}
                  onDeleteSaved={deleteSaved}
                  openTemplates={templatesNonce}
                />

                <div className="relative flex min-w-0 flex-1">
                  <PipelineCanvas
                    spec={spec}
                    glance={glance}
                    status={status}
                    selected={selectedStage}
                    onSelect={setSelectedStage}
                    onOpenStage={(id) => { if (id === 'features') openFeatureCanvas() }}
                  />

                  <BacktestsPanel
                    runs={runs}
                    sessionRunIds={sessionRuns.ids}
                    seedRun={sessionRuns.seed}
                    strategyId={currentId}
                    onFinish={refreshRuns}
                    onOpenReport={setReportRun}
                    onDeleteRun={deleteRun}
                    open={backtestsOpen}
                    onOpenChange={setBacktestsOpen}
                  />

                  {/* The front door, over the canvas rather than above it: what
                      is behind it is the default strategy, which is precisely
                      what it is offering to replace. */}
                  {specRevision === 0 && !startHereGone && (
                    <div className="absolute inset-0 z-10 flex items-start justify-center overflow-y-auto bg-background/70 p-6 backdrop-blur-sm">
                      <div className="w-full max-w-2xl">
                        <StartHere
                          chat={chat}
                          configured={configured}
                          spec={spec}
                          onApply={applyFromFrontDoor}
                          onDismiss={() => setStartHereGone(true)}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <StageInspector
                  selected={selectedStage}
                  spec={spec}
                  setSpec={setSpec}
                  stores={stores}
                  models={models}
                  explain={preview.explain}
                  coverage={preview.coverage}
                  options={preview.options}
                  defects={preview.defects}
                  applyPatch={applyPatch}
                  onStoresChanged={() => void refreshStores()}
                  onOpenFeatureCanvas={openFeatureCanvas}
                  unfinished={unfinished.length}
                  notes={selectedStage ? status[selectedStage].advisories : []}
                  blocking={stageBlocking}
                />
              </>
            }
            features={
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
                  testEnd: preview.explain?.effective_test_end ?? spec.test_end,
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
              />
            }
          />

        </div>

        {assistantOpen && (
          <AssistantDock
            chat={chat}
            configured={configured}
            spec={spec}
            // The assistant's only route into the spec, and the same three steps
            // the template gallery takes. The debounced preview hook turns
            // either into fresh server-rendered YAML for free.
            onApply={applySpec}
            onClose={() => setAssistantOpen(false)}
          />
        )}
      </div>

      <RunConfirmDialog
        open={runConfirmOpen}
        onOpenChange={setRunConfirmOpen}
        spec={spec}
        stores={stores}
        models={models}
        activeRun={runs.find(isActive)}
        onPreview={api.previewStrategy}
        initialBlockers={blockers}
        onStart={start}
        busy={busy}
      />

      <RunReportModal run={reportRun} onClose={() => setReportRun(null)} />

      <UnsavedChangesDialog
        pending={pending}
        changed={changed}
        onCancel={cancel}
        onDiscard={discard}
        saving={busy}
        onSave={() => { void save().then((ok) => { if (ok) resume() }) }}
      />
    </>
  )
}
