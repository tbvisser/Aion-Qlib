import { useState, useRef, useEffect, useCallback } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { Send, PanelRightOpen, PanelRightClose, X } from 'lucide-react'
import { ThreadList, ThreadListRef } from '@/features/rag/components/chat/ThreadList'
import { ChatView } from '@/features/rag/components/chat/ChatView'
import { ComposerMenu, ActiveModeChip, type ComposerMode } from '@/features/rag/components/chat/ComposerMenu'
import { AttachmentPreviewTray } from '@/features/rag/components/chat/AttachmentPreviewTray'
import { ChatFileDropOverlay } from '@/features/rag/components/chat/ChatFileDropOverlay'
import { PlanPanel } from '@/features/rag/components/deep/PlanPanel'
import { WorkspacePanel } from '@/features/rag/components/deep/WorkspacePanel'
import { SidecarPreview } from '@/features/rag/components/deep/SidecarPreview'
import { CitationSourcePanel } from '@/features/rag/components/citations/CitationSourcePanel'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { createThread, getTodos, getWorkspaceFiles, fetchApi } from '@/features/rag/lib/api'
import { getPastedImageFile } from '@/features/rag/lib/clipboardFiles'
import { useFileDrop } from '@/features/rag/hooks/useFileDrop'
import {
  createPendingAttachment,
  revokePendingAttachment,
  type PendingAttachment,
} from '@/features/rag/lib/pendingAttachments'
import type { TodoItem, AgentStatus, WorkspaceFile, HarnessRun, AnswerCitation, CitationVerificationMode } from '@/features/rag/types'

type SidecarMode = 'hidden' | 'list' | 'list-collapsed' | 'preview' | 'citation'
type WorkspaceFileReference = Pick<WorkspaceFile, 'file_path' | 'content_type' | 'size_bytes'>

export function RagChatPage() {
  const { threadId: urlThreadId } = useParams<{ threadId?: string }>()
  const navigate = useNavigate()
  const [initialMessage, setInitialMessage] = useState<string | undefined>(undefined)
  const [initialAttachments, setInitialAttachments] = useState<File[] | undefined>(undefined)
  const [welcomeInput, setWelcomeInput] = useState('')
  // Composer mode chosen on the welcome screen, carried into the new thread.
  const [welcomeMode, setWelcomeMode] = useState<ComposerMode>(null)
  const [welcomeFocusRequest, setWelcomeFocusRequest] = useState(0)
  const [creating, setCreating] = useState(false)
  const threadListRef = useRef<ThreadListRef>(null)
  const welcomeInputRef = useRef<HTMLTextAreaElement>(null)
  const welcomeAttachmentsRef = useRef<PendingAttachment[]>([])
  const location = useLocation()

  const [todos, setTodos] = useState<TodoItem[]>([])
  const [, setAgentStatus] = useState<AgentStatus | null>(null)
  const [sidecarMode, setSidecarMode] = useState<SidecarMode>('hidden')
  // Mobile-only: whether the full-screen plan/workspace overlay is open. The
  // desktop sidecar column (`hidden lg:flex`) is unaffected by this.
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false)
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([])
  const [welcomeAttachments, setWelcomeAttachments] = useState<PendingAttachment[]>([])
  const [activeHarnessRun, setActiveHarnessRun] = useState<HarnessRun | null>(null)

  const [viewingFile, setViewingFile] = useState<WorkspaceFile | null>(null)
  const [selectedCitation, setSelectedCitation] = useState<AnswerCitation | null>(null)
  const [selectedCitationMode, setSelectedCitationMode] = useState<CitationVerificationMode | null>(null)
  const selectedCitationRef = useRef<AnswerCitation | null>(null)
  const selectedCitationModeRef = useRef<CitationVerificationMode | null>(null)

  const selectedThreadId = urlThreadId ?? null

  // Show plan panel only when there are actual todos to display
  const showPlanPanel = selectedThreadId !== null && todos.length > 0
  const showWorkspacePanel = selectedThreadId !== null && workspaceFiles.length > 0
  const hasWelcomeAttachments = welcomeAttachments.length > 0

  useEffect(() => {
    welcomeAttachmentsRef.current = welcomeAttachments
  }, [welcomeAttachments])

  useEffect(() => {
    return () => {
      welcomeAttachmentsRef.current.forEach(revokePendingAttachment)
    }
  }, [])

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
    if (!selectedThreadId) {
      setTodos([])
      setAgentStatus(null)
      return
    }

    let cancelled = false
    getTodos(selectedThreadId)
      .then((data) => {
        if (!cancelled) setTodos(data)
      })
      .catch(() => {
        if (!cancelled) setTodos([])
      })

    // Reset agent status on thread switch
    setAgentStatus(null)

    return () => { cancelled = true }
  }, [selectedThreadId])

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
    if (!selectedThreadId) {
      setWorkspaceFiles([])
      return
    }

    let cancelled = false
    getWorkspaceFiles(selectedThreadId)
      .then((data) => {
        if (!cancelled) setWorkspaceFiles(data)
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFiles([])
      })

    // Fetch active harness run
    fetchApi<HarnessRun | null>(`/threads/${selectedThreadId}/harness`)
      .then((data) => {
        if (!cancelled) setActiveHarnessRun(data)
      })
      .catch(() => {
        if (!cancelled) setActiveHarnessRun(null)
      })

    return () => { cancelled = true }
  }, [selectedThreadId])

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
    if (selectedThreadId && fallbackFile) {
      handleFileClick({
        id: `workspace-reference-${filePath}`,
        thread_id: selectedThreadId,
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
  }, [handleFileClick, selectedThreadId])

  // Handle initialMessage passed via location state (e.g., from SkillsPage "Create with AI")
  useEffect(() => {
    const stateMessage = (location.state as { initialMessage?: string })?.initialMessage
    if (stateMessage && !creating) {
      // Clear the location state so it doesn't re-trigger on re-render
      window.history.replaceState({}, '')

      // Create a new thread with the message
      setCreating(true)
      createThread()
        .then((newThread) => {
          threadListRef.current?.addThread(newThread)
          setInitialMessage(stateMessage)
          navigate(`/chats/${newThread.id}`, { replace: true })
        })
        .catch((error) => {
          console.error('Failed to create thread from location state:', error)
        })
        .finally(() => {
          setCreating(false)
        })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleThreadTitleUpdate = (threadId: string, title: string) => {
    threadListRef.current?.updateThreadTitle(threadId, title)
  }

  const handleSelectThread = (threadId: string) => {
    if (!threadId) {
      setWelcomeFocusRequest(request => request + 1)
      // Start each new chat with a clean composer mode.
      setWelcomeMode(null)
      setWelcomeAttachments(prev => {
        prev.forEach(revokePendingAttachment)
        return []
      })
    }
    navigate(threadId ? `/chats/${threadId}` : '/chats')
    setInitialMessage(undefined)
    setInitialAttachments(undefined)
  }

  useEffect(() => {
    if (selectedThreadId || creating) return

    const frame = window.requestAnimationFrame(() => {
      welcomeInputRef.current?.focus()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [creating, selectedThreadId, welcomeFocusRequest])

  useEffect(() => {
    const textarea = welcomeInputRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    const styles = getComputedStyle(textarea)
    const border =
      (parseFloat(styles.borderTopWidth) || 0) +
      (parseFloat(styles.borderBottomWidth) || 0)
    textarea.style.height = `${textarea.scrollHeight + border}px`
  }, [welcomeInput])

  const handleWelcomeSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if ((!welcomeInput.trim() && welcomeAttachments.length === 0) || creating) return

    const message = welcomeInput.trim()
    const attachments = welcomeAttachments
    setCreating(true)
    try {
      const newThread = await createThread()
      threadListRef.current?.addThread(newThread)
      setInitialMessage(message)
      setInitialAttachments(attachments.map(attachment => attachment.file))
      navigate(`/chats/${newThread.id}`, { replace: true })
      setWelcomeInput('')
      setWelcomeAttachments([])
      attachments.forEach(revokePendingAttachment)
    } catch (error) {
      console.error('Failed to create thread:', error)
    } finally {
      setCreating(false)
    }
  }

  const handleWelcomeUploadFiles = useCallback((files: File[]) => {
    if (files.length === 0) return
    setWelcomeAttachments(prev => [
      ...prev,
      ...files.map(createPendingAttachment),
    ])
  }, [])

  const handleWelcomeUpload = useCallback((file: File) => {
    handleWelcomeUploadFiles([file])
  }, [handleWelcomeUploadFiles])

  const handleRemoveWelcomeAttachment = (id: string) => {
    setWelcomeAttachments(prev => {
      const attachment = prev.find(item => item.id === id)
      if (attachment) revokePendingAttachment(attachment)
      return prev.filter(item => item.id !== id)
    })
  }

  const handleWelcomePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFile = getPastedImageFile(e.clipboardData)
    if (!imageFile) return

    e.preventDefault()
    if (creating) return
    handleWelcomeUpload(imageFile)
  }

  const { draggingFiles: welcomeDraggingFiles } = useFileDrop({
    active: !selectedThreadId,
    disabled: creating,
    onFiles: handleWelcomeUploadFiles,
  })

  // Layout chrome (sidebar, mobile top bar) lives outside the page here — App
  // renders the shell beside <main> and this fills <main>. So the thread list
  // that was the RAG app's sidebar payload becomes an in-page left column,
  // matching the list+detail idiom of /documents and /lab/roster.
  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <ChatFileDropOverlay visible={welcomeDraggingFiles} />

      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border/50">
        <ThreadList
          ref={threadListRef}
          selectedThreadId={selectedThreadId}
          onSelectThread={handleSelectThread}
        />
      </aside>

      {/* Main content */}
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
          {selectedThreadId ? (
            <ChatView
              threadId={selectedThreadId}
              onThreadTitleUpdate={handleThreadTitleUpdate}
              onTodosUpdate={setTodos}
              onAgentStatusUpdate={setAgentStatus}
              onWorkspaceFileCreated={handleWorkspaceFileUpsert}
              onWorkspaceFileUpdated={handleWorkspaceFileUpsert}
              onFileClick={handleWorkspaceFileReferenceClick}
              onCitationClick={handleCitationClick}
              onCitationsUpdate={handleCitationsUpdate}
              activeCitationId={selectedCitation?.citation_id ?? null}
              initialMessage={initialMessage}
              initialDeepMode={welcomeMode !== null}
              initialHarnessMode={welcomeMode === 'contract_review' ? 'contract_review' : null}
              initialAttachments={initialAttachments}
              harnessRun={activeHarnessRun}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center animate-fade-in">
              <div className="text-center mb-8">
                <h1 className="text-3xl font-semibold tracking-tight mb-1">What can I help with?</h1>
              </div>
              <form onSubmit={handleWelcomeSubmit} className="w-full max-w-xl px-4">
                <ActiveModeChip
                  activeMode={welcomeMode}
                  locked={false}
                  onClear={() => setWelcomeMode(null)}
                />
                <div className={`relative focus-glow rounded-3xl ${hasWelcomeAttachments ? 'border border-border/50 bg-surface-2' : ''}`}>
                  <AttachmentPreviewTray
                    attachments={welcomeAttachments}
                    onRemove={handleRemoveWelcomeAttachment}
                    disabled={creating}
                  />
                  <Textarea
                    ref={welcomeInputRef}
                    value={welcomeInput}
                    onChange={(e) => setWelcomeInput(e.target.value)}
                    onPaste={handleWelcomePaste}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleWelcomeSubmit(e as unknown as React.FormEvent)
                      }
                    }}
                    placeholder="Ask anything..."
                    disabled={creating}
                    rows={1}
                    className={`min-h-[48px] max-h-[50vh] resize-none overflow-y-auto rounded-3xl pl-12 pr-12 py-3 text-base leading-6 transition-colors ${
                      hasWelcomeAttachments
                        ? 'border-0 bg-transparent focus-visible:ring-0 focus-visible:border-transparent'
                        : 'bg-surface-2 border-border/50 focus:border-primary/50'
                    }`}
                  />
                  <div className="absolute left-1.5 bottom-1.5 flex gap-1">
                    <ComposerMenu
                      activeMode={welcomeMode}
                      onModeChange={setWelcomeMode}
                      harnessLocked={false}
                      onUpload={handleWelcomeUpload}
                      uploading={creating}
                      showContextStats={false}
                      disabled={creating}
                    />
                  </div>
                  <Button
                    type="submit"
                    size="icon"
                    aria-label="Send message"
                    className="absolute right-1.5 bottom-1.5 rounded-full h-9 w-9 bg-primary hover:bg-primary/90 transition-all duration-200 btn-press"
                    disabled={(!welcomeInput.trim() && !hasWelcomeAttachments) || creating}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </form>
            </div>
          )}
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
            ) : sidecarMode === 'preview' && viewingFile && selectedThreadId ? (
              <SidecarPreview
                file={viewingFile}
                threadId={selectedThreadId}
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
        {viewingFile && selectedThreadId && !selectedCitation && (
          <div className="lg:hidden fixed inset-0 z-40 bg-background animate-fade-in">
            <SidecarPreview
              file={viewingFile}
              threadId={selectedThreadId}
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
    </div>
  )
}
