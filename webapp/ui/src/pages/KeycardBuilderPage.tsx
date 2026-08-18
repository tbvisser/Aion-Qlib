import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ReactFlowProvider } from '@xyflow/react'
import {
  ChevronDown,
  ChevronRight,
  Database,
  Settings2,
  Tag,
} from 'lucide-react'

import { KeycardAssistantDock } from '@/components/keycard/KeycardAssistantDock'
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
import { useSessionRuns } from '@/hooks/useSessionRuns'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  api,
  defaultKeycardSpec,
  type Keycard,
  type KeycardNodeTypeMeta,
  type KeycardSpec,
  type Run,
} from '@/lib/api'
import { NODE_TYPE_INFO, normaliseCategory } from '@/lib/keycardGraph/nodeRegistry'
import { missingRequiredCategories } from '@/lib/keycardGraph/keycardValidation'


export function KeycardBuilderPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const keycard = useKeycard(defaultKeycardSpec())
  const state = useKeycardState(keycard.spec)

  // Sync external load/save state into the local editor state.
  useEffect(() => {
    state.setSpec(keycard.spec)
  }, [keycard.spec])

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

  const dirty = useMemo(
    () => JSON.stringify(state.spec) !== JSON.stringify(keycard.baseline),
    [state.spec, keycard.baseline],
  )

  const { guard } = useUnsavedGuard(dirty)

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importReport, setImportReport] = useState<{ unknown: string[]; rejected: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const sessionRuns = useSessionRuns()
  const [backtestsOpen, setBacktestsOpen] = useBacktestsOpen()
  const [runs, setRuns] = useState<Run[]>([])
  const [reportRun, setReportRun] = useState<Run | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(true)

  const keycardChat = useKeycardChat({
    spec: state.spec,
    keycardId: keycard.currentId,
  })
  const keycardChatConfigured = useKeycardChatConfigured()

  const refreshRuns = useCallback(async () => {
    try {
      setRuns((await api.listRuns(500)).runs)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refreshRuns()
  }, [refreshRuns])

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

  const handleSave = useCallback(async () => {
    setBusy(true)
    const { stored, error: saveError } = await keycard.save()
    setBusy(false)
    if (stored) {
      setError(null)
      if (!id || id === 'new') {
        navigate(`/lab/keycards/${stored.id}`, { replace: true })
      }
    } else {
      setError(saveError)
    }
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
        title="Keycard Builder"
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
          onSave={handleSave}
          onRun={handleRun}
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
          <div className="border-b border-border/50 bg-muted/30 px-3 py-1.5">
            <p className="text-[10px] text-muted-foreground">
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
              onDeleteRun={async (run) => {
                setRuns((prev) => prev.filter((r) => r.id !== run.id))
                try {
                  await api.deleteRun(run.id)
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not delete run')
                } finally {
                  void refreshRuns()
                }
              }}
              open={backtestsOpen}
              onOpenChange={setBacktestsOpen}
            />

            <div className="pointer-events-auto absolute right-3 top-14 z-10 flex h-[38%] w-80 flex-col overflow-hidden rounded-xl border border-border/50 bg-card shadow-card">
              <NodeInspector
                spec={state.spec}
                selectedNodeId={state.selectedNodeId}
                metaByType={metaByType}
                defects={compile.defects}
                onChange={state.updateSpec}
                onChangeNode={state.updateNode}
              />
            </div>

            {assistantOpen && (
              <div className="pointer-events-auto absolute right-3 bottom-3 z-10 flex h-[50%] w-[34rem] flex-col overflow-hidden rounded-xl border border-border/50 bg-card/50 backdrop-blur shadow-card font-sans">
                <KeycardAssistantDock
                  chat={keycardChat}
                  configured={keycardChatConfigured}
                  spec={state.spec}
                  onApply={(patch) => state.setSpec(patch)}
                  onClose={() => setAssistantOpen(false)}
                />
              </div>
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

      <RunReportModal run={reportRun} onClose={() => setReportRun(null)} />
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
          className="flex w-full items-center gap-2 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {inputsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Database className="h-3.5 w-3.5" />
          Inputs & Variables
        </button>
        {inputsOpen && (
          <div className="border-t border-border/50 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">
              {spec.nodes.length} block{spec.nodes.length === 1 ? '' : 's'} · {spec.edges.length} connection{spec.edges.length === 1 ? '' : 's'}
            </p>
          </div>
        )}
      </div>

      <div className="pointer-events-auto rounded-xl border border-border/50 bg-card/95 shadow-card backdrop-blur">
        <button
          type="button"
          onClick={() => setPropsOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {propsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Settings2 className="h-3.5 w-3.5" />
          Project Properties
        </button>
        {propsOpen && (
          <div className="space-y-2 border-t border-border/50 px-3 py-2">
            {spec.tags.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Tag className="h-3 w-3" />
                <span className="truncate">{spec.tags.join(', ')}</span>
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              Template family: <span className="text-foreground">{spec.template_family || '—'}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Train: <span className="text-foreground">{spec.windows.train_start}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              Test: <span className="text-foreground">{spec.windows.test_end}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
