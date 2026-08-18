/**
 * The Strategy Builder.
 *
 * The whole strategy is a chain of seven stage cards on a canvas; clicking one
 * opens its fields in the right rail. That replaces a `form | canvas` toggle
 * where the form was a long column of controls and the canvas only ever held
 * factor expressions -- so nothing on screen ever showed the strategy as a
 * whole, which is the one thing a builder ought to show.
 *
 * Two panes share the canvas area: the pipeline, and the factor canvas reached
 * from the Features stage. **Both are mounted at all times**; the inactive one
 * is `invisible pointer-events-none`, never unmounted. That is load-bearing --
 * see the comment on the pane container.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Bot, FileCode2, Play } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { AssistantDock } from '@/components/builder/AssistantDock'
import { BacktestsPanel, useBacktestsOpen } from '@/components/builder/BacktestsPanel'
import { RunConfirmDialog } from '@/components/builder/RunConfirmDialog'
import { RunReportModal } from '@/components/runs/RunReportModal'
import { loadTemplates } from '@/hooks/useTemplates'
import { StartHere } from '@/components/builder/StartHere'
import { StrategyImport } from '@/components/builder/StrategyImport'
import { StrategyMenu } from '@/components/builder/StrategyMenu'
import { UnsavedChangesDialog } from '@/components/builder/UnsavedChangesDialog'
import { BuilderRail } from '@/components/canvas/BuilderRail'
import { FactorCanvas, type FeatureSetSnapshot } from '@/components/canvas/FactorCanvas'
import { PipelineCanvas } from '@/components/pipeline/PipelineCanvas'
import { COMPAT_FIELDS } from '@/components/pipeline/inspectors/compat'
import { StageInspector } from '@/components/pipeline/StageInspector'
import { StageStrip } from '@/components/pipeline/StageStrip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { useBuilderChat, useChatConfigured } from '@/hooks/useBuilderChat'
import { isActive } from '@/hooks/useRunStream'
import { useSessionRuns } from '@/hooks/useSessionRuns'
import { useStrategies } from '@/hooks/useStrategies'
import { useUniverseCount } from '@/hooks/useStoreUniverses'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  DEFAULT_STRATEGY, api,
  type DataStore, type FeatureMode, type FieldOptions, type ModelsResponse, type Run,
  type SpecDefect, type StoredStrategy, type StrategyCoverage, type StrategyExplain,
  type StrategySpec,
} from '@/lib/api'
import { mergeBlockers, mergeDefects } from '@/lib/blockers'
import { blocking, toSpecFeatures } from '@/lib/factorExpr/featureSet'
import { dirtyFields } from '@/lib/strategyDirty'
import { nextCopyName } from '@/lib/strategyNames'
import { fieldOf } from '@/lib/strategyOptions'
import { applyStore } from '@/lib/storeSwitch'
import {
  routeDefects, routeWarnings, unroutedWarnings,
} from '@/lib/strategyGraph/routeWarning'
import { firstBlockedStage, stageStatus } from '@/lib/strategyGraph/stageStatus'
import type { StageId } from '@/lib/strategyGraph/stages'
import { cn } from '@/lib/utils'

/** Which of the two canvases the pane area is showing. */
type Pane = 'pipeline' | 'features'

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
  const [yamlText, setYamlText] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  /**
   * The typed half of the same answer.
   *
   * `undefined` means the server did not send any — an older build — and the
   * page falls back to inferring severity and placement from `warnings`. An
   * empty array is a real answer and must not be confused with that.
   */
  const [defects, setDefects] = useState<SpecDefect[] | undefined>()
  /** What each field may be set to, judged against the rest of the spec. */
  const [options, setOptions] = useState<Record<string, FieldOptions> | undefined>()
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
  const [backtestsOpen, setBacktestsOpen] = useBacktestsOpen()
  /** Every run, fetched once and shared with the backtests panel. */
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
    void refreshRuns()
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

  // Deep-linking a saved strategy from the book. The guard is unnecessary on a
  // fresh page load, and using openSavedNow keeps the id so Save updates it.
  const strategyIdFromUrl = params.get('strategy')
  useEffect(() => {
    if (!strategyIdFromUrl || saved.length === 0 || currentId) return
    const s = saved.find((x) => x.id === strategyIdFromUrl)
    if (s) openSavedNow(s)
  }, [strategyIdFromUrl, saved.length, currentId, openSavedNow])

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

  const applySpec = useCallback((next: StrategySpec) => {
    guard({ label: `open “${next.name}”`, run: () => applySpecNow(next) })
  }, [guard, applySpecNow])

  const openSaved = useCallback((s: StoredStrategy) => {
    guard({ label: `open “${s.name}”`, run: () => openSavedNow(s) })
  }, [guard, openSavedNow])

  // Covers a tab close or a reload. An in-app route change cannot be guarded
  // here: `main.tsx` mounts a `<BrowserRouter>` and `useBlocker` needs a data
  // router, which is not a migration worth doing for this.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

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

  // Keep the YAML preview honest: it is regenerated by the backend from the
  // same function that produces the config qrun actually runs.
  //
  // This effect lives above the pane switch on purpose. The pane changes what
  // is rendered, never where state lives, so the preview is identical in both
  // and cannot drift into a client-side approximation in one of them.
  const preview = useCallback(async () => {
    try {
      const r = await api.previewStrategy(spec)
      setYamlText(r.yaml)
      setWarnings(r.warnings)
      setDefects(r.defects)
      setOptions(r.options)
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

  /**
   * Remove a finished run.
   *
   * Optimistic, then reconciled: the row is the only thing on screen that
   * refers to it, and waiting for a refetch to make a delete look like it
   * happened reads as a broken button.
   */
  const deleteRun = useCallback(async (target: Run) => {
    setRuns((prev) => prev.filter((r) => r.id !== target.id))
    try {
      await api.deleteRun(target.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the run')
    } finally {
      void refreshRuns()
    }
  }, [refreshRuns])

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
    const features = toSpecFeatures(canvas.features)
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
  const canvasIssues = featureErrors.map((i) => ({
    message: i.message,
    columnName: canvas?.features.find((f) => f.id === i.columnId)?.name,
  }))

  /**
   * Which stage card each problem belongs on, and what badge each card wears.
   *
   * Two roads to the same shape. When the server sends `defects` — a code, the
   * field it is about, and its severity — routing is a lookup and the tier is
   * read off the wire. When it does not, the old prefix tables infer both from
   * the message text; that path is what every server before this shipped, and
   * it cannot mention an unknown universe or benchmark at all.
   *
   * Merged before routing either way, because saying the same thing twice is
   * what `lib/blockers` exists to prevent.
   */
  const routed = useMemo(
    () => (defects
      ? routeDefects(mergeDefects(defects, canvasIssues), canvas?.features ?? [])
      : routeWarnings(mergeBlockers(warnings, canvasIssues), canvas?.features ?? [])),
    [defects, warnings.join(' '), canvasIssues.map((i) => i.message).join(' '),
     canvas?.features],
  )

  // Only the blocking tier may be counted: an advisory describes a run that
  // will finish and mean nothing, and a header chip reading "3 blocking" on a
  // strategy that runs fine is how a reader learns to ignore the chip. Both
  // tiers still route to a card.
  const blockers = useMemo(
    () => routed.filter((r) => !r.advisory).map((r) => r.message), [routed])

  /**
   * The blocking messages the inspector prints at the top of its rail.
   *
   * Everything routed to the stage *except* what the field's own control now
   * shows beneath itself. The notice is what guarantees no message is lost, so
   * it keeps everything it is not certain is already on screen — including
   * every message from the legacy `warnings` path, which carries no field.
   */
  const stageBlocking = useMemo(
    () => (selectedStage
      ? routed
        .filter((r) => r.stage === selectedStage && !r.advisory
                       && !COMPAT_FIELDS.has(fieldOf(r.path ?? '')))
        .map((r) => r.message)
      : []),
    [routed, selectedStage])

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
  const status = useMemo(
    () => stageStatus(routed, { coverage, unfinished: unfinished.length }),
    [routed, coverage, unfinished.length],
  )
  /**
   * Warnings no routing rule claimed.
   *
   * Rendered page-level so a string a future server invents cannot vanish. The
   * badges are the discoverable path; this is the one that cannot be closed.
   */
  const unrouted = useMemo(() => unroutedWarnings(routed), [routed])

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
        title="Strategy Builder"
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
            onSetVisibility={(s, v) => void setStrategyVisibility(s.id, v)}
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
            <YamlDialog yaml={yamlText} />
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

      <div className="border-b border-border/50 bg-amber-50/50 px-4 py-2 dark:bg-amber-950/20">
        <Notice tone="clay" icon={false}>
          This builder is being replaced by the new{' '}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => navigate('/lab/keycards/new')}
          >
            Keycard Builder
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

          {error && (
            <div className="border-b border-border/50 px-6 py-2">
              <Notice tone="destructive" icon={false}>{error}</Notice>
            </div>
          )}
          {unrouted.length > 0 && (
            <div className="border-b border-border/50 px-6 py-2">
              <Notice tone="clay">
                {unrouted.map((w) => <p key={w}>{w}</p>)}
              </Notice>
            </div>
          )}

          {/*
            Both panes are mounted, always. The inactive one is `invisible`
            (visibility: hidden), never `hidden`/`display:none` and never
            unmounted — three separate reasons:

            1. `toSpecFeatures` emits only *complete* columns, so unmounting
               `FactorCanvas` silently deletes every half-built one.
            2. Unmounting would add a second, implicit reseed path via
               mount-time `seed()`, which is exactly what `specRevision`'s
               contract forbids: it must remain the only signal the canvas
               accepts, or an ordinary pane toggle reseeds mid-edit.
            3. `display: none` collapses the box to 0×0, which React Flow's
               ResizeObserver sees and the viewport never recovers from.

            Belt and braces on top of that: an opaque background and an explicit
            z-order, so the active pane *covers* the other rather than merely
            out-painting it. Nothing in either pane is opaque on its own — the
            rails, the inspector and React Flow's `base.css` all set no
            background — so a stale build that lost `invisible` rendered both
            node layers superimposed rather than failing visibly. This makes
            that impossible whatever the cause.
          */}
          <div className="relative min-h-0 flex-1">
            <div
              className={cn('absolute inset-0 flex overflow-hidden bg-background',
                            pane === 'pipeline' ? 'z-10' : 'z-0 invisible pointer-events-none')}
            >
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
                  glance={{
                    store: stores.find((s) => s.key === spec.data_store),
                    explain,
                    models,
                    universeCount,
                    unfinished: unfinished.length,
                  }}
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
                explain={explain}
                coverage={coverage}
                options={options}
                defects={defects}
                applyPatch={applyPatch}
                onStoresChanged={() => void refreshStores()}
                onOpenFeatureCanvas={openFeatureCanvas}
                unfinished={unfinished.length}
                notes={selectedStage ? status[selectedStage].notes : []}
                blocking={stageBlocking}
              />
            </div>

            <div
              className={cn('absolute inset-0 flex overflow-hidden bg-background',
                            pane === 'features' ? 'z-10' : 'z-0 invisible pointer-events-none')}
            >
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
              />
            </div>
          </div>

        </div>

        {assistantOpen && (
          <AssistantDock
            chat={chat}
            configured={configured}
            spec={spec}
            // The assistant's only route into the spec, and the same three steps
            // the template gallery takes. The debounced preview effect above turns
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

/**
 * The generated config, one click away.
 *
 * Never a client-side approximation: this is the backend's own render of the
 * file qrun is handed, which is why the sentence underneath can be true.
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
