import { useState, useRef, useEffect, useCallback } from 'react'
import { PanelRightOpen, PanelRightClose, X } from 'lucide-react'
import { ChatView } from '@/features/rag/components/chat/ChatView'
import { type ComposerMode } from '@/features/rag/components/chat/ComposerMenu'
import { PlanPanel } from '@/features/rag/components/deep/PlanPanel'
import { WorkspacePanel } from '@/features/rag/components/deep/WorkspacePanel'
import { SidecarPreview } from '@/features/rag/components/deep/SidecarPreview'
import { CitationSourcePanel } from '@/features/rag/components/citations/CitationSourcePanel'
import { Button } from '@/components/ui/button'
import { getTodos, getWorkspaceFiles, fetchApi } from '@/features/rag/lib/api'
import type { TodoItem, AgentStatus, WorkspaceFile, HarnessRun, AnswerCitation, CitationVerificationMode } from '@/features/rag/types'

type SidecarMode = 'hidden' | 'list' | 'list-collapsed' | 'preview' | 'citation'
type WorkspaceFileReference = Pick<WorkspaceFile, 'file_path' | 'content_type' | 'size_bytes'>

interface ChatSurfaceProps {
  threadId: string
  initialMessage?: string
  initialAttachments?: File[]
  initialMode?: ComposerMode
  onThreadTitleUpdate?: (threadId: string, title: string) => void
}

const noopThreadTitleUpdate = () => {}

export function ChatSurface({
  threadId,
  initialMessage,
  initialAttachments,
  initialMode = null,
  onThreadTitleUpdate = noopThreadTitleUpdate,
}: ChatSurfaceProps) {
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [, setAgentStatus] = useState<AgentStatus | null>(null)
  const [sidecarMode, setSidecarMode] = useState<SidecarMode>('hidden')
  // Mobile-only: whether the full-screen plan/workspace overlay is open. The
  // desktop sidecar column (`hidden lg:flex`) is unaffected by this.
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false)
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([])
  const [activeHarnessRun, setActiveHarnessRun] = useState<HarnessRun | null>(null)

  const [viewingFile, setViewingFile] = useState<WorkspaceFile | null>(null)
  const [selectedCitation, setSelectedCitation] = useState<AnswerCitation | null>(null)
  const [selectedCitationMode, setSelectedCitationMode] = useState<CitationVerificationMode | null>(null)
  const selectedCitationRef = useRef<AnswerCitation | null>(null)
  const selectedCitationModeRef = useRef<CitationVerificationMode | null>(null)

  // Show plan panel only when there are actual todos to display
  const showPlanPanel = todos.length > 0
  const showWorkspacePanel = workspaceFiles.length > 0

  useEffect(() => {
    if (selectedCitation) {
      setSidecarMode('citation')
      return
    }
    if (viewingFile) {
      setSidecarMode('preview')
      return
    }
    const hasContent = todos.length > 0 || workspaceFiles.length > 0
    setSidecarMode((prev) => {
      if (!hasContent) return 'hidden'
      if (prev === 'list-collapsed') return 'list-collapsed'
      return 'list'
    })
  }, [selectedCitation, viewingFile, todos.length, workspaceFiles.length])

  // Load todos from REST when thread changes
  useEffect(() => {
    let cancelled = false
    getTodos(threadId)
      .then((data) => {
        if (!cancelled) setTodos(data)
      })
      .catch(() => {
        if (!cancelled) setTodos([])
      })

    // Reset agent status on thread switch
    setAgentStatus(null)

    return () => { cancelled = true }
  }, [threadId])

  // Load workspace files from REST when thread changes
  useEffect(() => {
    // Always close any open preview when the thread changes — the previewed
    // file belonged to the previous thread.
    setViewingFile(null)
    selectedCitationRef.current = null
    selectedCitationModeRef.current = null
    setSelectedCitation(null)
    setSelectedCitationMode(null)
    setMobilePanelOpen(false)
    // Clear the previous thread's run immediately so a stale harness doesn't
    // briefly leak into the newly selected thread's composer.
    setActiveHarnessRun(null)

    let cancelled = false
    getWorkspaceFiles(threadId)
      .then((data) => {
        if (!cancelled) setWorkspaceFiles(data)
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFiles([])
      })

    // Fetch active harness run
    fetchApi<HarnessRun | null>(`/threads/${threadId}/harness`)
      .then((data) => {
        if (!cancelled) setActiveHarnessRun(data)
      })
      .catch(() => {
        if (!cancelled) setActiveHarnessRun(null)
      })

    return () => { cancelled = true }
  }, [threadId])

  // Upsert workspace file from SSE events
  const handleWorkspaceFileUpsert = useCallback((file: WorkspaceFile) => {
    setWorkspaceFiles(prev => {
      const idx = prev.findIndex(f => f.file_path === file.file_path)
      if (idx >= 0) return [...prev.slice(0, idx), file, ...prev.slice(idx + 1)]
      return [...prev, file]
    })
  }, [])

  const handleFileClick = useCallback((file: WorkspaceFile) => {
    setViewingFile(file)
    selectedCitationRef.current = null
    selectedCitationModeRef.current = null
    setSelectedCitation(null)
  }, [])

  const handleCitationClick = useCallback((citation: AnswerCitation, mode: CitationVerificationMode | null) => {
    selectedCitationRef.current = citation
    selectedCitationModeRef.current = mode
    setSelectedCitation(citation)
    setSelectedCitationMode(mode)
    setViewingFile(null)
  }, [])

  const closeCitationPanel = useCallback(() => {
    selectedCitationRef.current = null
    selectedCitationModeRef.current = null
    setSelectedCitation(null)
    setSelectedCitationMode(null)
  }, [])

  const handleCitationsUpdate = useCallback((citations: AnswerCitation[], mode: CitationVerificationMode | null) => {
    const current = selectedCitationRef.current
    if (!current) return

    const latest = citations.find(citation => citation.citation_id === current.citation_id)
    if (!latest) return

    selectedCitationRef.current = latest
    selectedCitationModeRef.current = mode ?? selectedCitationModeRef.current
    setSelectedCitation(latest)
    setSelectedCitationMode(selectedCitationModeRef.current)
  }, [])

  const workspaceFilesRef = useRef(workspaceFiles)
  workspaceFilesRef.current = workspaceFiles

  const handleWorkspaceFileReferenceClick = useCallback((filename: string, fallbackFile?: WorkspaceFileReference) => {
    const filePath = fallbackFile?.file_path ?? filename
    const file = workspaceFilesRef.current.find(f => f.file_path === filePath)
    if (file) {
      handleFileClick(file)
      return
    }
    if (fallbackFile) {
      handleFileClick({
        id: `workspace-reference-${filePath}`,
        thread_id: threadId,
        file_path: filePath,
        size_bytes: fallbackFile.size_bytes,
        content_type: fallbackFile.content_type,
        source: 'upload',
        storage_path: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      return
    }
    console.warn(`Workspace file not found for: ${filePath}`)
  }, [handleFileClick, threadId])

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Below lg the sidecar column is hidden, so the plan/workspace
            overlay needs an in-page trigger. This replaces the rightSlot the
            RAG app's mobile top bar used to carry. */}
        {(showPlanPanel || showWorkspacePanel) && (
          <div className="flex shrink-0 items-center justify-end border-b border-border/50 px-2 py-1.5 lg:hidden">
            <Button
              variant="ghost"
              size="icon"
              data-testid="mobile-workspace-toggle"
              onClick={() => setMobilePanelOpen(true)}
              aria-label="Show plan and workspace"
            >
              <PanelRightOpen className="h-4 w-4" />
            </Button>
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatView
            threadId={threadId}
            onThreadTitleUpdate={onThreadTitleUpdate}
            onTodosUpdate={setTodos}
            onAgentStatusUpdate={setAgentStatus}
            onWorkspaceFileCreated={handleWorkspaceFileUpsert}
            onWorkspaceFileUpdated={handleWorkspaceFileUpsert}
            onFileClick={handleWorkspaceFileReferenceClick}
            onCitationClick={handleCitationClick}
            onCitationsUpdate={handleCitationsUpdate}
            activeCitationId={selectedCitation?.citation_id ?? null}
            initialMessage={initialMessage}
            initialDeepMode={initialMode !== null}
            initialHarnessMode={initialMode === 'contract_review' ? 'contract_review' : null}
            initialAttachments={initialAttachments}
            harnessRun={activeHarnessRun}
          />
        </div>
      </div>

      {/* Right sidebar - Plan Panel + Workspace Panel stacked, or Citation Source Panel when a citation is selected */}
      {sidecarMode !== 'hidden' && (
        <div
          data-testid="sidecar-column"
          data-mode={sidecarMode}
          className={`hidden lg:flex flex-col shrink-0 border-l border-border/50 bg-surface-1 transition-[width] duration-200 ease-out ${
            sidecarMode === 'list-collapsed' ? 'w-10' :
            sidecarMode === 'preview' || sidecarMode === 'citation' ? 'w-1/2' :
            'w-[300px]'
          }`}
        >
          {sidecarMode === 'list-collapsed' ? (
            <button
              onClick={() => setSidecarMode('list')}
              className="flex items-center justify-center w-10 py-2.5 hover:bg-surface-2 transition-colors"
              title="Expand sidebar"
              data-testid="sidecar-expand"
            >
              <PanelRightOpen className="h-4 w-4 text-muted-foreground" />
            </button>
          ) : sidecarMode === 'list' ? (
            <>
              <div className="flex items-center justify-end px-2 py-1.5 border-b border-border/50">
                <button
                  onClick={() => setSidecarMode('list-collapsed')}
                  className="p-1 rounded hover:bg-surface-2 transition-colors"
                  title="Collapse sidebar"
                  data-testid="sidecar-collapse"
                >
                  <PanelRightClose className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
              {showPlanPanel && (
                <div className="flex-1 min-h-0 overflow-hidden">
                  <PlanPanel todos={todos} locked={!!activeHarnessRun && activeHarnessRun.status !== 'completed' && activeHarnessRun.status !== 'failed'} />
                </div>
              )}
              {showWorkspacePanel && (
                <div className={`flex-1 min-h-0 overflow-hidden ${showPlanPanel ? 'border-t border-border/50' : ''}`}>
                  <WorkspacePanel files={workspaceFiles} onFileClick={handleFileClick} />
                </div>
              )}
            </>
          ) : sidecarMode === 'preview' && viewingFile ? (
            <SidecarPreview
              file={viewingFile}
              threadId={threadId}
              onClose={() => setViewingFile(null)}
            />
          ) : sidecarMode === 'citation' && selectedCitation ? (
            <CitationSourcePanel
              citation={selectedCitation}
              verificationMode={selectedCitationMode}
              onClose={closeCitationPanel}
            />
          ) : null}
        </div>
      )}

      {/* Narrow-screen citation panel (full-screen sheet) */}
      {selectedCitation && (
        <div className="lg:hidden fixed inset-0 z-40 bg-background animate-fade-in">
          <CitationSourcePanel
            citation={selectedCitation}
            verificationMode={selectedCitationMode}
            onClose={closeCitationPanel}
          />
        </div>
      )}

      {/* Narrow-screen workspace file preview (full-screen sheet) */}
      {viewingFile && !selectedCitation && (
        <div className="lg:hidden fixed inset-0 z-40 bg-background animate-fade-in">
          <SidecarPreview
            file={viewingFile}
            threadId={threadId}
            onClose={() => setViewingFile(null)}
          />
        </div>
      )}

      {/* Narrow-screen plan + workspace list (full-screen sheet) */}
      {mobilePanelOpen && !viewingFile && !selectedCitation && (showPlanPanel || showWorkspacePanel) && (
        <div className="lg:hidden fixed inset-0 z-40 flex flex-col bg-background animate-fade-in">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/50 px-4">
            <span className="text-sm font-medium">Plan &amp; workspace</span>
            <button
              onClick={() => setMobilePanelOpen(false)}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              aria-label="Close plan and workspace"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {showPlanPanel && (
              <div className="min-h-0 flex-1 overflow-hidden">
                <PlanPanel todos={todos} locked={!!activeHarnessRun && activeHarnessRun.status !== 'completed' && activeHarnessRun.status !== 'failed'} />
              </div>
            )}
            {showWorkspacePanel && (
              <div className={`min-h-0 flex-1 overflow-hidden ${showPlanPanel ? 'border-t border-border/50' : ''}`}>
                <WorkspacePanel files={workspaceFiles} onFileClick={handleFileClick} />
              </div>
            )}
          </div>
        </div>
      )}


    </div>
  )
}
