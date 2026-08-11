import { useState, useRef, useEffect } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ThreadList, ThreadListRef } from '@/features/rag/components/chat/ThreadList'
import { ChatSurface } from '@/features/rag/components/chat/ChatSurface'
import { WelcomeComposer } from '@/features/rag/components/chat/WelcomeComposer'
import { type ComposerMode } from '@/features/rag/components/chat/ComposerMenu'
import { createThread } from '@/features/rag/lib/api'

export function RagChatPage() {
  const { threadId: urlThreadId } = useParams<{ threadId?: string }>()
  const navigate = useNavigate()
  const [initialMessage, setInitialMessage] = useState<string | undefined>(undefined)
  const [initialAttachments, setInitialAttachments] = useState<File[] | undefined>(undefined)
  // Composer mode chosen on the welcome screen, carried into the new thread.
  const [initialMode, setInitialMode] = useState<ComposerMode>(null)
  const [welcomeFocusRequest, setWelcomeFocusRequest] = useState(0)
  const [creating, setCreating] = useState(false)
  const threadListRef = useRef<ThreadListRef>(null)
  const location = useLocation()

  const selectedThreadId = urlThreadId ?? null

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
      setInitialMode(null)
    }
    navigate(threadId ? `/chats/${threadId}` : '/chats')
    setInitialMessage(undefined)
    setInitialAttachments(undefined)
  }

  const handleWelcomeSubmit = async ({
    message,
    attachments,
    mode,
  }: { message: string; attachments: File[]; mode: ComposerMode }) => {
    setCreating(true)
    try {
      const newThread = await createThread()
      threadListRef.current?.addThread(newThread)
      setInitialMessage(message)
      setInitialAttachments(attachments)
      setInitialMode(mode)
      navigate(`/chats/${newThread.id}`, { replace: true })
    } catch (error) {
      console.error('Failed to create thread:', error)
      // Re-throw so the composer keeps the user's message and attachments.
      throw error
    } finally {
      setCreating(false)
    }
  }

  // Layout chrome (sidebar, mobile top bar) lives outside the page here — App
  // renders the shell beside <main> and this fills <main>. So the thread list
  // that was the RAG app's sidebar payload becomes an in-page left column,
  // matching the list+detail idiom of /documents and /lab/roster.
  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border/50">
        <ThreadList
          ref={threadListRef}
          selectedThreadId={selectedThreadId}
          onSelectThread={handleSelectThread}
        />
      </aside>

      {/* Main content */}
      {selectedThreadId ? (
        <ChatSurface
          threadId={selectedThreadId}
          initialMessage={initialMessage}
          initialAttachments={initialAttachments}
          initialMode={initialMode}
          onThreadTitleUpdate={handleThreadTitleUpdate}
        />
      ) : (
        <div className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="flex h-full flex-col items-center justify-center animate-fade-in">
                <div className="text-center mb-8">
                  <h1 className="text-3xl font-semibold tracking-tight mb-1">What can I help with?</h1>
                </div>
                <WelcomeComposer
                  onSubmit={handleWelcomeSubmit}
                  busy={creating}
                  focusToken={welcomeFocusRequest}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
