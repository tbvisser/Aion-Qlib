import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ReactFlowProvider } from '@xyflow/react'
import {
  ChevronDown,
  ChevronRight,
  Database,
  MessageSquare,
  Settings2,
  Tag,
} from 'lucide-react'

import { KeycardAssistantDock } from '@/components/keycard/KeycardAssistantDock'
import { UnsavedChangesDialog } from '@/components/builder/UnsavedChangesDialog'
import { KeycardCanvas } from '@/components/keycard/KeycardCanvas'
import { KeycardToolbar } from '@/components/keycard/KeycardToolbar'
import { NodeInspector } from '@/components/keycard/NodeInspector'
import { NodePalette } from '@/components/keycard/NodePalette'
import { BacktestsPanel, useBacktestsOpen } from '@/components/builder/BacktestsPanel'
import { RunReportModal } from '@/components/runs/RunReportModal'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Notice } from '@/components/ui/notice'
import { Textarea } from '@/components/ui/textarea'
import { useKeycard, toKeycardSpec } from '@/hooks/useKeycard'
import { useKeycardChat, useKeycardChatConfigured } from '@/hooks/useKeycardChat'
import { useKeycardCompile } from '@/hooks/useKeycardCompile'
import { useKeycardState } from '@/hooks/useKeycardState'
import { useRuns } from '@/hooks/useRuns'
import { useSessionRuns } from '@/hooks/useSessionRuns'
import { useBeforeUnloadWarning, useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  api,
  defaultKeycardSpec,
  type Keycard,
  type KeycardNodeTypeMeta,
  type KeycardSpec,
  type Run,
} from '@/lib/api'
import { NODE_TYPE_INFO, normaliseCategory } from '@/lib/keycardGraph/nodeRegistry'
import { changedKeys } from '@/lib/specDiff'
import { cn } from '@/lib/utils'
import { missingRequiredCategories } from '@/lib/keycardGraph/keycardValidation'


export function KeycardBuilderPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const keycard = useKeycard(defaultKeycardSpec())
  const state = useKeycardState(keycard.spec)

  // Sync external load/save state into the local editor state. Destructured
  // because `setSpec` is a stable dispatch wrapper while the `state` bag is
  // rebuilt every render — depending on the bag would re-run this constantly.
  const { setSpec: setEditorSpec } = state
  useEffect(() => {
    setEditorSpec(keycard.spec)
  }, [keycard.spec, setEditorSpec])

  useEffect(() => {
    if (id && id !== 'new') {
      void keycard.load(id)
    } else {
      keycard.reset(defaultKeycardSpec())
    }
    // Only run when the route id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const compile = useKeycardCompile(state.spec)

  // Per-key rather than one JSON compare, so the unsaved dialog can name what
  // changed — the same `changedKeys` the strategy builder's dirty dot uses.
  const changed = useMemo(
    () => changedKeys(
      keycard.baseline as unknown as Record<string, unknown>,
      state.spec as unknown as Record<string, unknown>,
    ),
    [state.spec, keycard.baseline],
  )
  const dirty = changed.length > 0

  const { guard, pending, discard, cancel, resume } = useUnsavedGuard(dirty)
  useBeforeUnloadWarning(dirty)

  const [importOpen, setImportOpen] = useState(false)
  const [runConfirmOpen, setRunConfirmOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importReport, setImportReport] = useState<{ unknown: string[]; rejected: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const sessionRuns = useSessionRuns()
  const [backtestsOpen, setBacktestsOpen] = useBacktestsOpen()
  const { runs, refresh: refreshRuns, remove: removeRun } = useRuns(setError)
  const [reportRun, setReportRun] = useState<Run | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(true)

  const keycardChat = useKeycardChat({
    spec: state.spec,
    keycardId: keycard.currentId,
  })
  const keycardChatConfigured = useKeycardChatConfigured()

  const [nodeTypes, setNodeTypes] = useState<KeycardNodeTypeMeta[]>([])

  useEffect(() => {
    api.listNodeTypes()
      .then((r) => setNodeTypes(r.node_types.flatMap((cat) => cat.items)))
      .catch(() => undefined)
  }, [])

  const metaByType = useMemo(() => {
    const map = new Map<string, KeycardNodeTypeMeta>()
    // Always include the static fallback registry so the canvas can render and
    // drop nodes even when the backend node-types endpoint is unreachable.
    for (const info of Object.values(NODE_TYPE_INFO)) {
      map.set(info.id, info as KeycardNodeTypeMeta)
    }
    nodeTypes.forEach((meta) => {
      // Backend categories are lowercase (e.g. 'data', 'rules'); normalise to
      // the canonical title-case keys used by the colour registry.
      const normalised = normaliseCategory(meta.category)
      map.set(meta.id, normalised ? { ...meta, category: normalised } : meta)
    })
    return map
  }, [nodeTypes])

  const missingCategories = useMemo(
    () => missingRequiredCategories(state.spec.nodes, metaByType),
    [state.spec.nodes, metaByType],
  )

  // For the run-confirm dialog: blockers hold the launch, advisories are
  // worth reading and never a reason to hold anything.
  const runBlockers = useMemo(
    () => compile.defects.filter((d) => d.severity === 'blocking').map((d) => d.message),
    [compile.defects],
  )
  const runAdvisories = useMemo(
    () => compile.defects.filter((d) => d.severity !== 'blocking').map((d) => d.message),
    [compile.defects],
  )
  const currentIdForRun = keycard.currentId

  /** Returns whether it worked, so "Save and continue" knows not to continue. */
  const handleSave = useCallback(async (): Promise<boolean> => {
    setBusy(true)
    const { stored, error: saveError } = await keycard.save()
    setBusy(false)
    if (stored) {
      setError(null)
      if (!id || id === 'new') {
        navigate(`/lab/keycards/${stored.id}`, { replace: true })
      }
      return true
    }
    setError(saveError)
    return false
  }, [keycard, id, navigate])

  const handleRun = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      let currentId = keycard.currentId
      if (!currentId) {
        const { stored, error: saveError } = await keycard.save()
        if (!stored) {
          setError(saveError ?? 'Save failed before run')
          setBusy(false)
          return
        }
        currentId = stored.id
        navigate(`/lab/keycards/${stored.id}`, { replace: true })
      }
      const run = await api.startKeycardRun(currentId)
      sessionRuns.add(run)
      setBacktestsOpen(true)
      void refreshRuns()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setBusy(false)
    }
  }, [keycard, navigate, sessionRuns, setBacktestsOpen, refreshRuns])

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(state.spec, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${state.spec.name || 'keycard'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [state.spec])

  const handleImport = useCallback(async () => {
    setError(null)
    try {
      const result = await api.importKeycard(importText)
      state.setSpec(result.spec)
      setImportReport({
        unknown: result.unknown_fields,
        rejected: result.rejected.map((r) => `${r.path}: ${r.message}`).join('\n'),
      })
      setImportText('')
      setImportOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed')
    }
  }, [importText, state])

  const handleDelete = useCallback(async () => {
    if (!keycard.currentId) return
    const ok = await keycard.remove()
    if (ok) {
      navigate('/lab/keycards/new', { replace: true })
    } else {
      setError(keycard.error)
    }
  }, [keycard, navigate])

  const handleUseTemplate = useCallback((k: Keycard) => {
    guard({
      label: `open “${k.name}”`,
      run: () => {
        const spec = toKeycardSpec(k)
        state.setSpec(spec)
        keycard.reset(spec)
        navigate('/lab/keycards/new', { replace: true })
      },
    })
  }, [guard, keycard, navigate, state])

  return (
    <>
      <PageHeader
        title="Strategy Builder"
        description="Build quant strategies with simple blocks."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAssistantOpen((v) => !v)}
            >
              {assistantOpen ? 'Hide SANA' : 'SANA'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                guard({
                  label: 'create a new keycard',
                  run: () => {
                    keycard.reset(defaultKeycardSpec())
                    navigate('/lab/keycards/new', { replace: true })
                  },
                })
              }}
            >
              New keycard
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <KeycardToolbar
          spec={state.spec}
          currentId={keycard.currentId}
          dirty={dirty}
          busy={busy || keycard.loading || compile.loading}
          defects={compile.defects}
          onNameChange={(name) => state.updateSpec({ name })}
          onSave={() => void handleSave()}
          onRun={() => setRunConfirmOpen(true)}
          onFocusBlocked={state.selectNode}
          onImport={() => setImportOpen(true)}
          onExport={handleExport}
          onDelete={handleDelete}
          onAutoLayout={state.autoLayout}
        />

        {error && (
          <div className="border-b border-border/50 px-4 py-2">
            <Notice tone="destructive" icon={false}>{error}</Notice>
          </div>
        )}
        {compile.error && !compile.offline && (
          <div className="border-b border-border/50 px-4 py-2">
            <Notice tone="clay" icon={false}>
              Preview unavailable: {compile.error}
            </Notice>
          </div>
        )}
        {compile.offline && (
          <div className="border-b border-border/50 px-4 py-2">
            <p className="text-micro text-muted-foreground">
              Compiler offline — you can still edit and save; validation will resume when the backend is available.
            </p>
          </div>
        )}

        {importReport && (importReport.unknown.length > 0 || importReport.rejected) && (
          <div className="border-b border-border/50 px-4 py-2">
            <Notice tone="clay" icon={false}>
              {importReport.unknown.length > 0 && (
                <p>Unknown fields: {importReport.unknown.join(', ')}</p>
              )}
              {importReport.rejected && (
                <p className="whitespace-pre-line">Rejected: {importReport.rejected}</p>
              )}
            </Notice>
          </div>
        )}

        {missingCategories.length > 0 && (
          <div className="border-b border-border/50 px-4 py-2">
            <Notice tone="clay" icon={false}>
              This keycard is missing required categories: {missingCategories.join(', ')}.
            </Notice>
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <NodePalette onUseTemplate={handleUseTemplate} />

          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <ReactFlowProvider>
              <KeycardCanvas
                spec={state.spec}
                metaByType={metaByType}
                defects={compile.defects}
                selectedNodeId={state.selectedNodeId}
                onSelectNode={state.selectNode}
                onChange={state.setSpec}
              />
            </ReactFlowProvider>

            <KeycardProjectDock spec={state.spec} />

            <BacktestsPanel
              runs={runs}
              sessionRunIds={sessionRuns.ids}
              seedRun={sessionRuns.seed}
              strategyId={undefined}
              onFinish={refreshRuns}
              onOpenReport={setReportRun}
              onDeleteRun={removeRun}
              open={backtestsOpen}
              onOpenChange={setBacktestsOpen}
            />

            {/* The backtests panel (30rem, z-20, top-right, and it opens
                itself when a run starts) would otherwise sit exactly on top of
                this rail; step aside while it is open instead of being
                silently covered. */}
            <div
              className={cn(
                'pointer-events-auto absolute top-14 z-10 flex h-[38%] w-80 flex-col overflow-hidden rounded-xl border border-border/50 bg-card shadow-card',
                backtestsOpen ? 'right-[31.5rem]' : 'right-3',
              )}
            >
              <NodeInspector
                spec={state.spec}
                selectedNodeId={state.selectedNodeId}
                metaByType={metaByType}
                defects={compile.defects}
                onChange={state.updateSpec}
                onChangeNode={state.updateNode}
              />
            </div>

            {assistantOpen ? (
              <div className="pointer-events-auto absolute right-3 bottom-3 z-10 flex h-[50%] w-[34rem] flex-col overflow-hidden rounded-xl border border-border/50 bg-card/50 backdrop-blur shadow-card font-sans">
                <KeycardAssistantDock
                  chat={keycardChat}
                  configured={keycardChatConfigured}
                  spec={state.spec}
                  onApply={(patch) => state.setSpec(patch)}
                  onClose={() => setAssistantOpen(false)}
                />
              </div>
            ) : (
              <Button
                type="button"
                size="icon"
                onClick={() => setAssistantOpen(true)}
                aria-label="Open SANA"
                title="Open SANA"
                className="pointer-events-auto absolute right-3 bottom-3 z-10 h-10 w-10 rounded-full shadow-card btn-press"
              >
                <MessageSquare className="h-5 w-5" />
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">Import keycard</DialogTitle>
          </DialogHeader>
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste JSON or YAML…"
            rows={16}
            className="font-mono text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={() => void handleImport()}>Import</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* The last look before the compute is spent — the same policy the
          strategy builder documents at length: the Run button is never
          disabled-with-no-explanation, blockers hold the launch in here,
          where the reasons are written out. */}
      <Dialog open={runConfirmOpen} onOpenChange={setRunConfirmOpen}>
        <DialogContent className="sm:max-w-lg" data-testid="keycard-run-confirm">
          <DialogHeader>
            <DialogTitle className="text-sm">Test keycard</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {state.spec.name || 'Untitled keycard'} · {state.spec.nodes.length} block{state.spec.nodes.length === 1 ? '' : 's'} · {state.spec.edges.length} connection{state.spec.edges.length === 1 ? '' : 's'}
          </p>
          {runBlockers.length > 0 && (
            <Notice tone="clay">
              {runBlockers.map((m) => <p key={m}>{m}</p>)}
            </Notice>
          )}
          {runAdvisories.length > 0 && (
            <Notice tone="muted" icon={false}>
              {runAdvisories.map((m) => <p key={m}>{m}</p>)}
            </Notice>
          )}
          {!currentIdForRun && (
            <p className="text-label text-muted-foreground">
              This keycard is saved first, then run.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setRunConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="keycard-start-backtest"
              disabled={busy || runBlockers.length > 0}
              title={runBlockers.length ? runBlockers.join('\n') : undefined}
              onClick={() => { setRunConfirmOpen(false); void handleRun() }}
            >
              Start backtest
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <RunReportModal run={reportRun} onClose={() => setReportRun(null)} />

      {/* Without this the guard's stashed action waits for a dialog that never
          renders — "New keycard" and "use template" were silent no-ops
          whenever the spec was dirty. */}
      <UnsavedChangesDialog
        pending={pending}
        changed={changed}
        onCancel={cancel}
        onDiscard={discard}
        saving={busy}
        onSave={() => { void handleSave().then((ok) => { if (ok) resume() }) }}
      />
    </>
  )
}

function KeycardProjectDock({ spec }: { spec: KeycardSpec }) {
  const [inputsOpen, setInputsOpen] = useState(false)
  const [propsOpen, setPropsOpen] = useState(true)

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex w-64 flex-col gap-2">
      <div className="pointer-events-auto rounded-xl border border-border/50 bg-card/95 shadow-card backdrop-blur">
        <button
          type="button"
          onClick={() => setInputsOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-micro font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {inputsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Database className="h-3.5 w-3.5" />
          Inputs & Variables
        </button>
        {inputsOpen && (
          <div className="border-t border-border/50 px-3 py-2">
            <p className="text-label text-muted-foreground">
              {spec.nodes.length} block{spec.nodes.length === 1 ? '' : 's'} · {spec.edges.length} connection{spec.edges.length === 1 ? '' : 's'}
            </p>
          </div>
        )}
      </div>

      <div className="pointer-events-auto rounded-xl border border-border/50 bg-card/95 shadow-card backdrop-blur">
        <button
          type="button"
          onClick={() => setPropsOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-micro font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {propsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Settings2 className="h-3.5 w-3.5" />
          Project Properties
        </button>
        {propsOpen && (
          <div className="space-y-2 border-t border-border/50 px-3 py-2">
            {spec.tags.length > 0 && (
              <div className="flex items-center gap-1.5 text-label text-muted-foreground">
                <Tag className="h-3 w-3" />
                <span className="truncate">{spec.tags.join(', ')}</span>
              </div>
            )}
            <div className="text-label text-muted-foreground">
              Template family: <span className="text-foreground">{spec.template_family || '—'}</span>
            </div>
            <div className="text-label text-muted-foreground">
              Train: <span className="text-foreground">{spec.windows.train_start}</span>
            </div>
            <div className="text-label text-muted-foreground">
              Test: <span className="text-foreground">{spec.windows.test_end}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
