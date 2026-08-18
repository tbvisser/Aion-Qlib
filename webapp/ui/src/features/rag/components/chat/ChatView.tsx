import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { File as FileIcon, FileImage, Loader2, Shield } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { getMessages, sendMessage, getPublicSettings, getCompactions, uploadWorkspaceFile, getWorkspaceFileDownloadUrl, DEFAULT_CONTEXT_WINDOW } from '@/features/rag/lib/api'
import { getPastedImageFile } from '@/features/rag/lib/clipboardFiles'
import { StepsPanel } from './StepsPanel'
import { SubAgentPanel } from './SubAgentPanel'
import { CodeExecutionPanel } from './CodeExecutionPanel'
import { ThinkingPanel } from './ThinkingPanel'
import { CompactionMarker } from './CompactionMarker'
import { MessageActions } from './MessageActions'
import { ActiveModeChip, type ComposerMode } from './ComposerMenu'
import { ComposerShell } from './ComposerShell'
import { AttachmentPreviewTray } from './AttachmentPreviewTray'
import { ChatFileDropOverlay } from './ChatFileDropOverlay'
import { readModelConfig } from '@/features/rag/hooks/useModelConfig'
import { useFileDrop } from '@/features/rag/hooks/useFileDrop'
import { HarnessPhasePanel } from './HarnessPhasePanel'
import { CitationButton } from '@/features/rag/components/citations/CitationButton'
import {
  citationIdFromHref,
  citationGroupIdFromHref,
  findCitation,
  injectCitationLinks,
  isCitationGroupHref,
  isCitationHref,
} from '@/features/rag/components/citations/citationUtils'
import type { Message, ToolCallInfo, TokenUsage, TodoItem, AgentStatus, WorkspaceFile, HarnessRun, Compaction, AnswerCitation, CitationVerificationMode } from '@/features/rag/types'
import {
  chatStreamStore,
  useChatStreamSlice,
  type ConversationAttachment,
  type ConversationItem,
  type CitationBucket,
} from '@/features/rag/lib/chatStreamStore'
import {
  createPendingAttachment,
  revokePendingAttachment,
  type PendingAttachment,
} from '@/features/rag/lib/pendingAttachments'
import { parseTextWithThinking, stripThinkTags } from '@/features/rag/lib/thinking'

interface ChatViewProps {
  threadId: string
  onThreadTitleUpdate?: (threadId: string, title: string) => void
  onTodosUpdate?: (todos: TodoItem[]) => void
  onAgentStatusUpdate?: (status: AgentStatus | null) => void
  onWorkspaceFileCreated?: (file: WorkspaceFile) => void
  onWorkspaceFileUpdated?: (file: WorkspaceFile) => void
  onFileClick?: (filename: string, file?: WorkspaceFileReference) => void
  onCitationClick?: (citation: AnswerCitation, verificationMode: CitationVerificationMode | null) => void
  onCitationsUpdate?: (citations: AnswerCitation[], verificationMode: CitationVerificationMode | null) => void
  activeCitationId?: string | null
  initialMessage?: string
  /** Seed the composer mode for a freshly created thread (welcome-screen carry-over). */
  initialDeepMode?: boolean
  initialHarnessMode?: string | null
  initialAttachments?: File[]
  harnessRun?: HarnessRun | null
}

type WorkspaceFileReference = Pick<WorkspaceFile, 'file_path' | 'content_type' | 'size_bytes'>

interface AssistantTextProps {
  content: string
  citations?: AnswerCitation[]
  verificationMode?: CitationVerificationMode | null
  activeCitationId?: string | null
  onCitationClick?: (citation: AnswerCitation, mode: CitationVerificationMode | null) => void
}

function CitationGroupToggleChip({
  expanded,
  onToggle,
}: {
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-label={expanded ? 'Collapse citations' : 'Show more citations'}
      title={expanded ? 'Collapse citations' : 'Show more citations'}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
      className="inline-flex items-center justify-center align-baseline mx-0.5 h-[1.25em] min-w-[1.25em] px-1 rounded-full border border-border bg-muted/70 text-[0.7em] leading-none font-medium text-muted-foreground transition-colors cursor-pointer hover:bg-muted"
    >
      {expanded ? 'x' : '...'}
    </button>
  )
}

function AssistantText({ content, citations, verificationMode, activeCitationId, onCitationClick }: AssistantTextProps) {
  const [expandedCitationGroups, setExpandedCitationGroups] = useState<Set<string>>(() => new Set())
  const toggleCitationGroup = useCallback((groupId: string) => {
    setExpandedCitationGroups((previous) => {
      const next = new Set(previous)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  useEffect(() => {
    setExpandedCitationGroups(new Set())
  }, [content, citations])

  const transformed = useMemo(
    () => {
      if (citations && citations.length > 0) {
        return injectCitationLinks(content, citations, {
          expandedGroups: expandedCitationGroups,
        })
      }
      return content
    },
    [content, citations, expandedCitationGroups],
  )
  const citationContextRef = useRef({
    citations,
    verificationMode,
    activeCitationId,
    onCitationClick,
    content,
    expandedCitationGroups,
    toggleCitationGroup,
  })
  citationContextRef.current = {
    citations,
    verificationMode,
    activeCitationId,
    onCitationClick,
    content,
    expandedCitationGroups,
    toggleCitationGroup,
  }

  const markdownComponents = useMemo<Components>(
    () => ({
      a: ({ href, children, node: _node, ...rest }) => {
        if (isCitationGroupHref(href)) {
          const groupId = citationGroupIdFromHref(href)
          if (!groupId) return null
          const {
            expandedCitationGroups: currentExpandedCitationGroups,
            toggleCitationGroup: currentToggleCitationGroup,
          } = citationContextRef.current
          return (
            <CitationGroupToggleChip
              expanded={currentExpandedCitationGroups.has(groupId)}
              onToggle={() => currentToggleCitationGroup(groupId)}
            />
          )
        }
        if (isCitationHref(href)) {
          const id = citationIdFromHref(href) || ''
          const {
            citations: currentCitations,
            verificationMode: currentVerificationMode,
            activeCitationId: currentActiveCitationId,
            onCitationClick: currentOnCitationClick,
          } = citationContextRef.current
          const cite = findCitation(currentCitations, id)
          return (
            <CitationButton
              citation={cite}
              fallbackLabel={typeof children === 'string' ? children : undefined}
              verificationMode={currentVerificationMode}
              active={!!cite && cite.citation_id === currentActiveCitationId}
              onView={(c) => {
                // Re-resolve from the live bucket at click time: a chip cited
                // mid-stream is upgraded in place (lightweight -> full target),
                // so the citation captured when this node first rendered may be
                // missing target.exact. Reading the ref ensures the click opens
                // the cited passage, not a stale targetless citation.
                const latest = citationContextRef.current.citations
                const fresh = (latest && findCitation(latest, c.citation_id)) || c
                currentOnCitationClick?.(fresh, currentVerificationMode ?? null)
              }}
            />
          )
        }
        return (
          <a href={href} {...rest} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        )
      },
    }),
    [],
  )

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      // react-markdown sanitizes URLs to a safe scheme allowlist; let our
      // custom schemes through so the custom <a> renderer can render chips.
      urlTransform={(url) =>
        typeof url === 'string'
        && (url.startsWith('citation:') || url.startsWith('citation-more:') || url.startsWith('claim-warning:'))
          ? url
          : defaultUrlTransform(url)
      }
      components={markdownComponents}
    >
      {transformed}
    </ReactMarkdown>
  )
}

// Within this many px of the bottom counts as "following" the stream. Smaller
// than a typical mouse-wheel notch (~100px) so a single scroll-up disengages
// auto-follow, but large enough to ignore sub-pixel rounding and make
// re-engaging (by scrolling back down) forgiving.
const NEAR_BOTTOM_PX = 64

function getUsageColor(ratio: number): string {
  if (ratio >= 0.8) return 'var(--color-destructive, hsl(0, 84%, 60%))'
  if (ratio >= 0.6) return 'var(--color-warning, hsl(45, 93%, 47%))'
  return 'var(--color-success, hsl(142, 71%, 45%))'
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 10000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return tokens.toString()
}

function UserAttachments({
  attachments,
  onFileClick,
}: {
  attachments?: ConversationAttachment[]
  onFileClick?: (filename: string, file?: WorkspaceFileReference) => void
}) {
  if (!attachments || attachments.length === 0) return null

  return (
    <div className="mb-2 flex max-w-[85%] flex-row flex-wrap justify-end gap-2">
      {attachments.map((attachment) => {
        const image = attachment.previewUrl && attachment.contentType.startsWith('image/')
        const canOpen = !!attachment.filePath && !!onFileClick
        const attachmentTitle = attachment.filePath ?? attachment.fileName
        const attachmentTestId = `message-attachment-${attachment.filePath ?? attachment.fileName}`
        const handleOpen = () => {
          if (!attachment.filePath) return
          onFileClick?.(attachment.filePath, {
            file_path: attachment.filePath,
            content_type: attachment.contentType,
            size_bytes: attachment.sizeBytes,
          })
        }
        const frameClass = `relative h-32 w-44 shrink-0 overflow-hidden rounded-xl border border-border/50 bg-surface-2 shadow-sm transition-colors ${
          canOpen ? 'cursor-pointer hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40' : ''
        }`
        if (image) {
          const preview = (
            <img
              src={attachment.previewUrl ?? undefined}
              alt={attachment.fileName}
              className="h-full w-full object-cover"
            />
          )
          return canOpen ? (
            <button
              key={attachment.id}
              type="button"
              data-testid={attachmentTestId}
              onClick={handleOpen}
              className={frameClass}
              title={attachmentTitle}
              aria-label={`Open ${attachment.fileName} preview`}
            >
              {preview}
            </button>
          ) : (
            <div
              key={attachment.id}
              data-testid={attachmentTestId}
              className={frameClass}
              title={attachmentTitle}
            >
              {preview}
            </div>
          )
        }
        const fileCard = (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center text-muted-foreground">
            {attachment.contentType.startsWith('image/') ? (
              <FileImage className="h-5 w-5 shrink-0" />
            ) : (
              <FileIcon className="h-5 w-5 shrink-0" />
            )}
            <span className="w-full truncate text-xs">{attachment.fileName}</span>
          </div>
        )
        return canOpen ? (
          <button
            key={attachment.id}
            type="button"
            data-testid={attachmentTestId}
            onClick={handleOpen}
            className={frameClass}
            title={attachmentTitle}
            aria-label={`Open ${attachment.fileName} preview`}
          >
            {fileCard}
          </button>
        ) : (
          <div
            key={attachment.id}
            data-testid={attachmentTestId}
            className={frameClass}
            title={attachmentTitle}
          >
            {fileCard}
          </div>
        )
      })}
    </div>
  )
}

function groupSequentialToolItems(items: ConversationItem[]): ConversationItem[] {
  const grouped: ConversationItem[] = []

  for (const item of items) {
    const previous = grouped[grouped.length - 1]
    if (item.type === 'tools' && previous?.type === 'tools') {
      grouped[grouped.length - 1] = {
        ...previous,
        id: `${previous.id}+${item.id}`,
        toolCalls: [...previous.toolCalls, ...item.toolCalls],
      }
      continue
    }
    grouped.push(item)
  }

  return grouped
}

async function hydrateMessageAttachments(threadId: string, msg: Message): Promise<ConversationAttachment[] | undefined> {
  if (!msg.attachments || msg.attachments.length === 0) return undefined

  const attachments = await Promise.all(msg.attachments.map(async (attachment) => {
    const contentType = attachment.content_type || 'application/octet-stream'
    let previewUrl: string | null = null
    if (contentType.startsWith('image/')) {
      try {
        previewUrl = await getWorkspaceFileDownloadUrl(threadId, attachment.file_path)
      } catch {
        previewUrl = null
      }
    }
    return {
      id: `${msg.id}-${attachment.file_path}`,
      fileName: attachment.file_path.split('/').pop() ?? attachment.file_path,
      filePath: attachment.file_path,
      contentType,
      sizeBytes: attachment.size_bytes || 0,
      previewUrl,
    }
  }))

  return attachments
}

export function ChatView({ threadId, onThreadTitleUpdate, onTodosUpdate, onAgentStatusUpdate, onWorkspaceFileCreated, onWorkspaceFileUpdated, onFileClick, onCitationClick, onCitationsUpdate, activeCitationId, initialMessage, initialDeepMode, initialHarnessMode, initialAttachments, harnessRun }: ChatViewProps) {
  // Streaming-critical state lives in a per-thread module store so an in-flight
  // response survives navigating away and back: the component unmounts / its
  // threadId changes, but the store and the still-running fetch do not. Read the
  // current thread's slice here; the streaming callbacks in doSend write to it
  // (bound to the thread the send started on, not whatever is on screen now).
  const slice = useChatStreamSlice(threadId)
  const { conversation, citationsByKey, sending, waiting, uploading, error, redactionStage, tokenUsage } = slice
  // An assistant turn can render as several `assistant-text` segments (thinking
  // splits, multi-round tool use) that share a messageKey. Show the action bar
  // only under the last segment of each message, and copy the whole message.
  const lastAssistantSegmentIds = useMemo(() => {
    const lastByKey = new Map<string, string>()
    for (const item of conversation) {
      if (item.type === 'assistant-text') lastByKey.set(item.messageKey ?? item.id, item.id)
    }
    return new Set(lastByKey.values())
  }, [conversation])
  const assistantTextByKey = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const item of conversation) {
      if (item.type !== 'assistant-text') continue
      const key = item.messageKey ?? item.id
      byKey.set(key, byKey.has(key) ? `${byKey.get(key)}\n\n${item.content}` : item.content)
    }
    return byKey
  }, [conversation])
  const [input, setInput] = useState('')
  // Skip the loading spinner when re-entering a thread whose live stream we'll
  // adopt from the store (the load effect short-circuits the DB fetch).
  const [loading, setLoading] = useState(() => chatStreamStore.getStatus(threadId) !== 'streaming')
  const [deepMode, setDeepMode] = useState(initialDeepMode ?? false)
  const [harnessMode, setHarnessMode] = useState<string | null>(initialHarnessMode ?? null)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([])
  const previousThreadIdRef = useRef(threadId)
  const [isTokenUsageOpen, setIsTokenUsageOpen] = useState(false)
  const [contextWindow, setContextWindow] = useState<number>(DEFAULT_CONTEXT_WINDOW)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const initialMessageSentRef = useRef(false)
  // Auto-follow keeps the view pinned to the newest token while a response
  // streams. It disengages the moment the user scrolls up (so they can read
  // back) and re-engages once they scroll back to the bottom. A ref (not state)
  // lets the scroll listener and the streaming effect share one live value
  // without re-running on every token.
  const autoFollowRef = useRef(true)

  // Recompute follow state from scroll position. Every input method (wheel,
  // trackpad, scrollbar, keyboard, touch) moves scrollTop and fires 'scroll',
  // so this one handler covers them all. Our own pin lands at distance ~0,
  // which simply keeps follow engaged.
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const { scrollTop, scrollHeight, clientHeight } = container
    autoFollowRef.current = scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_PX
  }, [])

  // Callback ref: wire the scroll listener to whichever scroll container is
  // mounted. The container is absent during the loading and empty states, so
  // attaching in a plain effect could miss it; a callback ref fires exactly on
  // mount and unmount regardless of the conditional render.
  const attachScrollContainer = useCallback((node: HTMLDivElement | null) => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.removeEventListener('scroll', handleScroll)
    }
    scrollContainerRef.current = node
    node?.addEventListener('scroll', handleScroll, { passive: true })
  }, [handleScroll])

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments
  }, [pendingAttachments])

  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach(revokePendingAttachment)
    }
  }, [])

  // Pin to the bottom on new content, but only while auto-follow is engaged.
  useEffect(() => {
    if (!autoFollowRef.current) return
    const container = scrollContainerRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [conversation])

  // Fetch context window limit on mount
  useEffect(() => {
    getPublicSettings()
      .then(s => setContextWindow(s.context_window))
      .catch(() => {/* fallback already set in useState default */})
  }, [])

  // Restore token usage from localStorage when thread changes. Skip while a
  // stream is live for this thread — its slice already holds the live count, and
  // overwriting it with the prior turn's stored value would flicker the meter.
  useEffect(() => {
    if (chatStreamStore.getStatus(threadId) !== 'streaming') {
      const stored = localStorage.getItem(`tokenUsage:${threadId}`)
      chatStreamStore.patch(threadId, { tokenUsage: stored ? JSON.parse(stored) : null })
    }
    setIsTokenUsageOpen(false)
  }, [threadId])

  // Reset composer mode only when the actual thread changes. React StrictMode
  // runs mount effects twice in development, so a did-mount boolean would clear
  // the welcome-screen mode carry-over before the first message is sent.
  useEffect(() => {
    if (previousThreadIdRef.current === threadId) {
      return
    }
    previousThreadIdRef.current = threadId
    setDeepMode(false)
    setHarnessMode(null)
    setPendingAttachments(prev => {
      prev.forEach(revokePendingAttachment)
      return []
    })
  }, [threadId])

  // Reflect the thread's committed harness run: lock the harness in and keep
  // follow-up context flowing. Set-only — clearing is handled by the thread
  // reset above, so this never wipes the welcome-screen carry-over on mount.
  useEffect(() => {
    if (harnessRun && harnessRun.status !== 'failed') {
      setHarnessMode(harnessRun.harness_type)
      setDeepMode(true)
    }
  }, [harnessRun])

  // Load messages from DB and convert to conversation items
  useEffect(() => {
    let cancelled = false
    initialMessageSentRef.current = false
    // Open each thread pinned to the latest message (and following any in-flight
    // stream); a scroll-up from a prior thread shouldn't carry over.
    autoFollowRef.current = true

    // Tell the store which thread is on screen, so a stream running for a
    // different (off-screen) thread knows not to push its parent-UI side effects
    // (todos, workspace files) into this view.
    chatStreamStore.setActiveThread(threadId)
    const clearActive = () => {
      if (chatStreamStore.getActiveThread() === threadId) chatStreamStore.setActiveThread(null)
    }

    // A stream is still in flight for this thread (it started before we navigated
    // away and back). Adopt its live slice instead of reloading from the DB,
    // which would clobber the half-streamed answer with not-yet-persisted rows.
    if (chatStreamStore.getStatus(threadId) === 'streaming') {
      setLoading(false)
      return () => { cancelled = true; clearActive() }
    }
    // A stream that finished while we were away: the answer is persisted now, so
    // drop the slice and reload from the DB (the single source of truth).
    if (chatStreamStore.getStatus(threadId) === 'done') {
      chatStreamStore.reset(threadId)
    }

    const loadMessages = async () => {
      setLoading(true)
      try {
        const [data, compactions] = await Promise.all([
          getMessages(threadId),
          getCompactions(threadId).catch((err) => {
            // Don't break the chat load -- compactions are auxiliary. But make
            // the failure observable: silent swallowing makes the missing
            // markers look like a hallucination to the user (assistant
            // references content the user can't see) with no signal to ops.
            console.error('[chat] failed to load thread compactions', err)
            return [] as Compaction[]
          }),
        ])
        if (!cancelled) {
          // Convert DB messages to conversation items, including tool calls
          // Each assistant message row is one agentic round, so processing
          // them in created_at order naturally produces interleaved rendering.
          //
          // Compactions are interleaved AFTER the message whose
          // sequence_number == covers_to_sequence. Sort compactions oldest first
          // and pop them in once their boundary message has been emitted.
          const sortedCompactions = [...compactions].sort(
            (a, b) => a.covers_to_sequence - b.covers_to_sequence
          )
          const items: ConversationItem[] = []
          const citationsAcc: Record<string, CitationBucket> = {}
          const userAttachmentPromises: Promise<{ id: string; attachments?: ConversationAttachment[] }>[] = []
          const drainCompactions = (uptoSequence: number) => {
            while (
              sortedCompactions.length > 0 &&
              sortedCompactions[0].covers_to_sequence <= uptoSequence
            ) {
              const c = sortedCompactions.shift()!
              items.push({
                type: 'compaction' as const,
                id: `compaction-${c.id}`,
                summary: c.summary_text,
                evictedCount: c.evicted_message_count,
                createdAt: c.created_at,
                modelUsed: c.model_used,
              })
            }
          }
          data.forEach((msg: Message) => {
            if (msg.role === 'user') {
              items.push({ type: 'user' as const, id: msg.id, content: msg.content })
              if (msg.attachments && msg.attachments.length > 0) {
                userAttachmentPromises.push(
                  hydrateMessageAttachments(threadId, msg).then((attachments) => ({ id: msg.id, attachments })),
                )
              }
            } else {
              // Process tool calls for this round (if any)
              if (msg.tool_calls && msg.tool_calls.length > 0) {
                // Regular tool calls — include tools with sub_agent_state/code_execution_state
                // as completed steps (they display in StepsPanel), then render their
                // expanded panels separately below.
                const regularTools = msg.tool_calls.filter(
                  tc => !tc.code_execution_state && !tc.sub_agent_state
                )
                // Also include sub-agent/code-exec tool calls as completed step entries
                const wrapperTools = msg.tool_calls.filter(
                  tc => tc.sub_agent_state || tc.code_execution_state
                ).map(tc => ({ ...tc, status: 'completed' as const }))
                const allStepTools = [...regularTools, ...wrapperTools]
                if (allStepTools.length > 0) {
                  items.push({ type: 'tools' as const, id: `${msg.id}-tools`, toolCalls: allStepTools })
                }

                // Sub-agent and code execution panels from persisted state
                msg.tool_calls.forEach((tc, idx) => {
                  if (tc.sub_agent_state) {
                    items.push({
                      type: 'subagent' as const,
                      id: `${msg.id}-subagent-${idx}`,
                      state: { ...tc.sub_agent_state, active: false },
                    })
                  }
                  if (tc.code_execution_state) {
                    items.push({
                      type: 'code-execution' as const,
                      id: `${msg.id}-code-exec-${idx}`,
                      state: { ...tc.code_execution_state, active: false },
                    })
                  }
                })
              }

              // Render phase panels BEFORE this message if harness_phases_before is set
              if (msg.harness_phases_before?.length && harnessRun?.phases?.length) {
                const statusMap: Record<string, 'running' | 'completed' | 'error'> = {
                  completed: 'completed',
                  running: 'running',
                  failed: 'error',
                  pending: 'completed',
                  skipped: 'error',
                }
                for (const phaseIdx of msg.harness_phases_before) {
                  const phase = harnessRun.phases[phaseIdx]
                  if (!phase) continue
                  const restoredToolCalls = (phase.tool_calls || []).map(tc => ({
                    toolName: tc.tool_name,
                    arguments: tc.arguments,
                    result: tc.result || undefined,
                    status: 'completed' as const,
                  }))
                  items.push({
                    type: 'harness-phase' as const,
                    id: `${msg.id}-harness-${phase.index}`,
                    phase: {
                      phaseIndex: phase.index,
                      phaseName: phase.name,
                      phaseDescription: phase.description,
                      status: statusMap[phase.status] || 'completed',
                      resultMarkdown: phase.result_markdown || '',
                      toolCalls: restoredToolCalls,
                      isHumanInput: phase.phase_type === 'llm_human_input',
                    },
                  })
                }
              }

              // Text content (may be empty for tool-only rounds)
              if (msg.content && msg.content.trim()) {
                // Parse thinking tags from stored content (may have multiple blocks)
                const segments = parseTextWithThinking(msg.content)
                segments.forEach((seg, idx) => {
                  if (seg.type === 'thinking') {
                    items.push({ type: 'thinking' as const, id: `${msg.id}-seg-${idx}`, content: seg.content, isStreaming: false })
                  } else {
                    items.push({ type: 'assistant-text' as const, id: `${msg.id}-seg-${idx}`, content: seg.content, messageKey: msg.id })
                  }
                })
              }

              if (msg.citations && msg.citations.length > 0) {
                citationsAcc[msg.id] = {
                  citations: msg.citations,
                  mode: msg.verification_mode ?? null,
                }
              }
            }
            if (typeof msg.sequence_number === 'number') {
              drainCompactions(msg.sequence_number)
            }
          })
          // Any compactions covering beyond the last message land at the tail.
          drainCompactions(Number.MAX_SAFE_INTEGER)
          if (userAttachmentPromises.length > 0) {
            const hydrated = await Promise.all(userAttachmentPromises)
            const attachmentsById = new Map(hydrated.map(item => [item.id, item.attachments]))
            for (const item of items) {
              if (item.type === 'user') {
                const attachments = attachmentsById.get(item.id)
                if (attachments && attachments.length > 0) item.attachments = attachments
              }
            }
          }
          chatStreamStore.setConversation(threadId, items)
          chatStreamStore.setCitations(threadId, citationsAcc)
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load messages:', error)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadMessages()
    return () => { cancelled = true; clearActive() }
  }, [threadId, harnessRun])

  const doSend = async (userMessage: string, attachments: PendingAttachment[] = []) => {
    // Bind this send to the thread it started on. The component may switch to a
    // different threadId (or unmount) while the stream is still running; these
    // shadows keep every callback below writing to the originating thread's slice
    // and scratch in the store, so the answer survives navigation instead of
    // leaking into whatever thread happens to be on screen now.
    const tid = threadId
    if ((!userMessage.trim() && attachments.length === 0) || chatStreamStore.getSlice(tid).sending) return

    const sc = chatStreamStore.getScratch(tid)
    const setConversation = (updater: (prev: ConversationItem[]) => ConversationItem[]) =>
      chatStreamStore.updateConversation(tid, updater)
    const setCitationsByKey = (
      updater: (prev: Record<string, CitationBucket>) => Record<string, CitationBucket>,
    ) => chatStreamStore.updateCitations(tid, updater)
    const setSending = (v: boolean) => chatStreamStore.patch(tid, { sending: v })
    const setWaiting = (v: boolean) => chatStreamStore.patch(tid, { waiting: v })
    const setError = (v: string | null) => chatStreamStore.patch(tid, { error: v })
    const setRedactionStage = (v: string | null) => chatStreamStore.patch(tid, { redactionStage: v })
    // Per-thread like the setters above: an upload started here must not lock
    // another thread's composer if the user navigates away mid-upload.
    const setUploading = (v: boolean) => chatStreamStore.patch(tid, { uploading: v })
    const setTokenUsage = (v: TokenUsage) => chatStreamStore.setTokenUsage(tid, v)
    // `.current` proxies onto the per-thread scratch: the ref-style reads/writes
    // in the callbacks below stay verbatim, but the values now persist in the
    // store instead of useRefs that a remount would reset.
    const responseIdRef = { get current(): string { return sc.responseId }, set current(v: string) { sc.responseId = v } }
    const rawTextBufferRef = { get current(): string { return sc.rawTextBuffer }, set current(v: string) { sc.rawTextBuffer = v } }
    const textPhaseRef = { get current(): number { return sc.textPhase }, set current(v: number) { sc.textPhase = v } }
    const activeHarnessPhaseRef = { get current(): number | null { return sc.activeHarnessPhase }, set current(v: number | null) { sc.activeHarnessPhase = v } }
    const toolGroupCounterRef = { get current(): number { return sc.toolGroupCounter }, set current(v: number) { sc.toolGroupCounter = v } }
    const abortControllerRef = { get current(): AbortController | null { return sc.abortController }, set current(v: AbortController | null) { sc.abortController = v } }
    // Only push parent-UI side effects (todos, workspace files) when this thread
    // is the one on screen; a background stream must not overwrite the view.
    const isActiveThread = () => chatStreamStore.getActiveThread() === tid

    const isFirstMessage = chatStreamStore.getSlice(tid).conversation.length === 0
    const userMsgId = `user-${Date.now()}`
    responseIdRef.current = `response-${Date.now()}`

    setSending(true)
    setWaiting(true)
    setError(null)
    // Sending re-engages follow, then scrolls to the bottom for the new message.
    autoFollowRef.current = true
    requestAnimationFrame(() => {
      const container = scrollContainerRef.current
      if (container) container.scrollTop = container.scrollHeight
    })

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    if (isFirstMessage && onThreadTitleUpdate) {
      // Set temporary title while waiting for LLM-generated one
      const titleSeed = userMessage || attachments[0]?.file.name || 'Attached file'
      const tempTitle = titleSeed.length > 50
        ? titleSeed.substring(0, 47) + '...'
        : titleSeed
      onThreadTitleUpdate(tid, tempTitle)
    }

    rawTextBufferRef.current = ''
    textPhaseRef.current = 0
    toolGroupCounterRef.current = 0
    activeHarnessPhaseRef.current = null

    const modelCfg = readModelConfig()
    try {
      let uploadedFiles: Array<{
        id: string
        file_path: string
        content_type: string
        size_bytes: number
        storage_path: string | null
      }> = []
      if (attachments.length > 0) {
        setUploading(true)
        uploadedFiles = await Promise.all(attachments.map((attachment) => uploadWorkspaceFile(tid, attachment.file)))
        setUploading(false)
        for (const result of uploadedFiles) {
          if (isActiveThread()) {
            onWorkspaceFileCreated?.({
              id: result.id,
              thread_id: tid,
              file_path: result.file_path,
              size_bytes: result.size_bytes,
              content_type: result.content_type,
              source: 'upload',
              storage_path: result.storage_path,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
          }
        }
      }

      const displayContent = userMessage.trim()
      const sentAttachments: ConversationAttachment[] = attachments.map((attachment, index) => {
        const uploaded = uploadedFiles[index]
        return {
          id: attachment.id,
          fileName: attachment.file.name,
          filePath: uploaded?.file_path,
          contentType: uploaded?.content_type ?? attachment.file.type,
          sizeBytes: uploaded?.size_bytes ?? attachment.file.size,
          previewUrl: attachment.previewUrl,
        }
      })
      setConversation(prev => [...prev, {
        type: 'user',
        id: userMsgId,
        content: displayContent,
        attachments: sentAttachments.length > 0 ? sentAttachments : undefined,
      }])

      await sendMessage({
        threadId: tid,
        content: userMessage,
        deepMode,
        harnessMode: harnessMode || undefined,
        model: modelCfg.model || undefined,
        thinking: modelCfg.thinking,
        reasoningEffort: modelCfg.reasoningEffort,
        attachmentFilePaths: uploadedFiles.map(file => file.file_path),
        onTextDelta: (text) => {
          setWaiting(false)

          // During harness mode, route text_delta to the active phase panel
          if (activeHarnessPhaseRef.current !== null) {
            const responseId = responseIdRef.current
            const phaseIdx = activeHarnessPhaseRef.current
            const phaseId = `${responseId}-harness-${phaseIdx}`
            setConversation(prev => prev.map(item =>
              item.id === phaseId && item.type === 'harness-phase'
                ? { ...item, phase: { ...item.phase, resultMarkdown: item.phase.resultMarkdown + text } }
                : item
            ))
            return
          }

          rawTextBufferRef.current += text

          const responseId = responseIdRef.current
          const phase = textPhaseRef.current
          const segments = parseTextWithThinking(rawTextBufferRef.current)

          setConversation(prev => {
            // Only remove items from the CURRENT phase (not previous phases)
            const phasePrefix = `${responseId}-phase${phase}-`
            const filtered = prev.filter(item => !item.id.startsWith(phasePrefix))

            // Create conversation items for each segment in this phase
            const newItems: ConversationItem[] = segments.map((seg, idx) => {
              if (seg.type === 'thinking') {
                return {
                  type: 'thinking' as const,
                  id: `${phasePrefix}${idx}`,
                  content: seg.content,
                  isStreaming: !seg.isComplete,
                }
              } else {
                return {
                  type: 'assistant-text' as const,
                  id: `${phasePrefix}${idx}`,
                  content: seg.content,
                  messageKey: responseId,
                }
              }
            })

            return [...filtered, ...newItems]
          })
        },
        onDone: () => {
          setSending(false)
          setWaiting(false)
          setRedactionStage(null)
          abortControllerRef.current = null
          // Reset agent status so PlanPanel spinner stops
          if (onAgentStatusUpdate) onAgentStatusUpdate(null)
        },
        onError: (err) => {
          console.error('Stream error:', err)
          setError(err)
          setSending(false)
          setWaiting(false)
          setRedactionStage(null)
          abortControllerRef.current = null
          // Reset agent status on error
          if (onAgentStatusUpdate) onAgentStatusUpdate(null)
        },
        onToolCallPending: (toolName) => {
          // Early notification: LLM has started generating a tool call
          // but arguments are still streaming. Show immediately so the user
          // sees progress instead of a gap after the text response ends.
          textPhaseRef.current += 1
          rawTextBufferRef.current = ''

          const pendingToolCall: ToolCallInfo = { tool_name: toolName, arguments: '', status: 'running' }
          setConversation(prev => {
            // Append to last tools group if it's the most recent conversation item
            const lastItem = prev[prev.length - 1]
            if (lastItem?.type === 'tools') {
              return [...prev.slice(0, -1), { ...lastItem, toolCalls: [...lastItem.toolCalls, pendingToolCall] }]
            }
            // New tools group needed (text was inserted between rounds)
            toolGroupCounterRef.current += 1
            const toolsId = `${responseIdRef.current}-tools-${toolGroupCounterRef.current}`
            return [...prev, { type: 'tools', id: toolsId, toolCalls: [pendingToolCall] }]
          })
        },
        onToolCallDelta: (toolName, argumentsDelta) => {
          // Accumulate argument chunks on the running tool call
          // so the StepsPanel can show a live code preview.
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'tools') return item
              const idx = item.toolCalls.findIndex(
                tc => tc.tool_name === toolName && tc.status === 'running'
              )
              if (idx === -1) return item
              const updated = [...item.toolCalls]
              updated[idx] = { ...updated[idx], arguments: updated[idx].arguments + argumentsDelta }
              return { ...item, toolCalls: updated }
            })
          })
        },
        onToolCallStart: (toolName, args, toolCallId) => {
          // During harness mode, nest tool calls inside the active phase panel
          if (activeHarnessPhaseRef.current !== null) {
            const responseId = responseIdRef.current
            const phaseIdx = activeHarnessPhaseRef.current
            const phaseId = `${responseId}-harness-${phaseIdx}`
            setConversation(prev => prev.map(item =>
              item.id === phaseId && item.type === 'harness-phase'
                ? {
                    ...item,
                    phase: {
                      ...item.phase,
                      toolCalls: [...item.phase.toolCalls, { toolCallId, toolName, arguments: args, status: 'running' as const }],
                    },
                  }
                : item
            ))
            return
          }

          // Full tool call ready — upgrade the existing running entry
          // (created by pending + deltas) with final arguments,
          // or create a new one if tool_call_pending wasn't emitted.
          textPhaseRef.current += 1
          rawTextBufferRef.current = ''

          setConversation(prev => {
            // Find the LAST tools group (search backwards) so we target the
            // correct round when multiple tool groups exist across rounds.
            let existingIdx = -1
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].type === 'tools') {
                existingIdx = i
                break
              }
            }
            if (existingIdx !== -1) {
              const item = prev[existingIdx]
              if (item.type !== 'tools') return prev
              // Find the running entry for this tool (may already have partial args from deltas)
              const runningIdx = item.toolCalls.findIndex(
                tc => tc.tool_name === toolName && tc.status === 'running'
              )
              if (runningIdx !== -1) {
                // Upgrade with final complete arguments
                const updated = [...item.toolCalls]
                updated[runningIdx] = { ...updated[runningIdx], arguments: args }
                return [...prev.slice(0, existingIdx), { ...item, toolCalls: updated }, ...prev.slice(existingIdx + 1)]
              }
              // No running entry — add as new tool call
              const newToolCall: ToolCallInfo = { tool_name: toolName, arguments: args, status: 'running' }
              return [...prev.slice(0, existingIdx), { ...item, toolCalls: [...item.toolCalls, newToolCall] }, ...prev.slice(existingIdx + 1)]
            }
            // No tools group yet — create one
            toolGroupCounterRef.current += 1
            const toolsId = `${responseIdRef.current}-tools-${toolGroupCounterRef.current}`
            const newToolCall: ToolCallInfo = { tool_name: toolName, arguments: args, status: 'running' }
            return [...prev, { type: 'tools', id: toolsId, toolCalls: [newToolCall] }]
          })
        },
        onToolCallComplete: (toolName, resultSummary, result, toolCallId) => {
          // During harness mode, update tool call inside the active phase panel
          if (activeHarnessPhaseRef.current !== null) {
            const responseId = responseIdRef.current
            const phaseIdx = activeHarnessPhaseRef.current
            const phaseId = `${responseId}-harness-${phaseIdx}`
            setConversation(prev => prev.map(item => {
              if (item.id !== phaseId || item.type !== 'harness-phase') return item
              const tcs = item.phase.toolCalls.map(tc => {
                // Match by unique tool_call_id when available (avoids duplicate name collisions)
                if (toolCallId && tc.toolCallId) {
                  return tc.toolCallId === toolCallId
                    ? { ...tc, status: 'completed' as const, result: resultSummary || result }
                    : tc
                }
                // Fallback: match first running entry with same name
                return tc.toolName === toolName && tc.status === 'running'
                  ? { ...tc, status: 'completed' as const, result: resultSummary || result }
                  : tc
              })
              return { ...item, phase: { ...item.phase, toolCalls: tcs } }
            }))
            return
          }

          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'tools') return item
              const idx = item.toolCalls.findIndex(tc => tc.tool_name === toolName && tc.status === 'running')
              if (idx === -1) return item
              const updated = [...item.toolCalls]
              updated[idx] = { ...updated[idx], status: 'completed', result_summary: resultSummary, result }
              return { ...item, toolCalls: updated }
            })
          })
        },
        onSubAgentStart: (documentId, filename) => {
          const subagentId = `${responseIdRef.current}-subagent`
          // Mark analyze_document tool as completed
          setConversation(prev => {
            const updated = prev.map(item => {
              if (item.type !== 'tools') return item
              return {
                ...item,
                toolCalls: item.toolCalls.map(tc =>
                  tc.tool_name === 'analyze_document' ? { ...tc, status: 'completed' as const } : tc
                )
              }
            })
            // Add subagent item
            return [...updated, {
              type: 'subagent' as const,
              id: subagentId,
              state: {
                active: true,
                mode: 'analyze' as const,
                documentId,
                filename,
                reasoning: '',
                status: 'running' as const,
              }
            }]
          })
        },
        onSubAgentReasoning: (content) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent') return item
              return { ...item, state: { ...item.state, reasoning: item.state.reasoning + content } }
            })
          })
        },
        onSubAgentComplete: (result) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent') return item
              return { ...item, state: { ...item.state, status: 'completed' as const, result: result || item.state.result } }
            })
          })
        },
        onSubAgentError: (error) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent') return item
              return {
                ...item,
                state: { ...item.state, status: 'error' as const, reasoning: item.state.reasoning + '\n\nError: ' + error }
              }
            })
          })
        },
        onTaskSubAgentStart: (subAgentId, description) => {
          const itemId = `${responseIdRef.current}-subagent-${subAgentId}`
          // Mark only the FIRST running task tool call as completed (not all)
          setConversation(prev => {
            let markedOne = false
            const updated = prev.map(item => {
              if (item.type !== 'tools' || markedOne) return item
              const runningIdx = item.toolCalls.findIndex(
                tc => tc.tool_name === 'task' && tc.status === 'running'
              )
              if (runningIdx === -1) return item
              markedOne = true
              const updatedCalls = [...item.toolCalls]
              updatedCalls[runningIdx] = { ...updatedCalls[runningIdx], status: 'completed' as const, result_summary: 'Delegated' }
              return { ...item, toolCalls: updatedCalls }
            })
            return [...updated, {
              type: 'subagent' as const,
              id: itemId,
              state: {
                active: true,
                mode: 'task' as const,
                description,
                brief: description,
                subAgentId,
                reasoning: '',
                status: 'running' as const,
              }
            }]
          })
        },
        onTaskSubAgentProgress: (subAgentId, content) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent' || item.state.subAgentId !== subAgentId) return item
              return { ...item, state: { ...item.state, reasoning: item.state.reasoning + content } }
            })
          })
        },
        onTaskSubAgentComplete: (subAgentId, result) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent' || item.state.subAgentId !== subAgentId) return item
              return { ...item, state: { ...item.state, status: 'completed' as const, result: result || item.state.result } }
            })
          })
        },
        onTaskSubAgentError: (subAgentId, error) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent' || item.state.subAgentId !== subAgentId) return item
              return {
                ...item,
                state: { ...item.state, status: 'error' as const, reasoning: item.state.reasoning + '\n\nError: ' + error }
              }
            })
          })
        },
        onTaskSubAgentToolStart: (subAgentId, toolName, args) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent' || item.state.subAgentId !== subAgentId) return item
              let parsedArgs: Record<string, any> = {}
              try { parsedArgs = JSON.parse(args) } catch { /* ignore */ }
              const newToolCall = {
                tool_name: toolName,
                arguments: parsedArgs,
                round: 0,
                status: 'running' as const,
              }
              return {
                ...item,
                state: {
                  ...item.state,
                  taskToolCalls: [...(item.state.taskToolCalls || []), newToolCall],
                }
              }
            })
          })
        },
        onTaskSubAgentToolComplete: (subAgentId, toolName, resultSummary) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent' || item.state.subAgentId !== subAgentId) return item
              const toolCalls = [...(item.state.taskToolCalls || [])]
              for (let i = toolCalls.length - 1; i >= 0; i--) {
                if (toolCalls[i].tool_name === toolName && toolCalls[i].status === 'running') {
                  toolCalls[i] = { ...toolCalls[i], status: 'completed', result_summary: resultSummary }
                  break
                }
              }
              return {
                ...item,
                state: { ...item.state, taskToolCalls: toolCalls }
              }
            })
          })
        },
        onExplorerStart: (researchQuery) => {
          const subagentId = `${responseIdRef.current}-subagent`
          // Mark explore_knowledge_base tool as completed
          setConversation(prev => {
            const updated = prev.map(item => {
              if (item.type !== 'tools') return item
              return {
                ...item,
                toolCalls: item.toolCalls.map(tc =>
                  tc.tool_name === 'explore_knowledge_base' ? { ...tc, status: 'completed' as const } : tc
                )
              }
            })
            // Add explorer subagent item
            return [...updated, {
              type: 'subagent' as const,
              id: subagentId,
              state: {
                active: true,
                mode: 'explore' as const,
                researchQuery,
                brief: researchQuery,
                explorerToolCalls: [],
                reasoning: '',
                status: 'running' as const,
              }
            }]
          })
        },
        onExplorerToolCall: (toolName, args, round) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent' || item.state.mode !== 'explore') return item
              const newToolCall = {
                tool_name: toolName,
                arguments: args,
                round,
                status: 'running' as const,
              }
              return {
                ...item,
                state: {
                  ...item.state,
                  explorerToolCalls: [...(item.state.explorerToolCalls || []), newToolCall],
                }
              }
            })
          })
        },
        onExplorerToolResult: (toolName, resultSummary) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent' || item.state.mode !== 'explore') return item
              const toolCalls = [...(item.state.explorerToolCalls || [])]
              // Find the last running tool call with this name and mark complete
              for (let i = toolCalls.length - 1; i >= 0; i--) {
                if (toolCalls[i].tool_name === toolName && toolCalls[i].status === 'running') {
                  toolCalls[i] = { ...toolCalls[i], status: 'completed', result_summary: resultSummary }
                  break
                }
              }
              return {
                ...item,
                state: { ...item.state, explorerToolCalls: toolCalls }
              }
            })
          })
        },
        onExplorerReasoning: (content) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent' || item.state.mode !== 'explore') return item
              return { ...item, state: { ...item.state, reasoning: item.state.reasoning + content } }
            })
          })
        },
        onExplorerComplete: (findings) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent' || item.state.mode !== 'explore') return item
              return { ...item, state: { ...item.state, status: 'completed' as const, result: findings || item.state.result } }
            })
          })
        },
        onExplorerError: (error) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'subagent' || item.state.mode !== 'explore') return item
              return {
                ...item,
                state: { ...item.state, status: 'error' as const, reasoning: item.state.reasoning + '\n\nError: ' + error }
              }
            })
          })
        },
        onCodeExecutionStart: (executionId, language, codePreview) => {
          const codeExecId = `${responseIdRef.current}-code-exec-${executionId}`
          // Mark execute_code tool as completed
          setConversation(prev => {
            const updated = prev.map(item => {
              if (item.type !== 'tools') return item
              return {
                ...item,
                toolCalls: item.toolCalls.map(tc =>
                  tc.tool_name === 'execute_code' && tc.status === 'running'
                    ? { ...tc, status: 'completed' as const }
                    : tc
                )
              }
            })
            return [...updated, {
              type: 'code-execution' as const,
              id: codeExecId,
              state: {
                active: true,
                executionId,
                language,
                codePreview,
                stdout: '',
                stderr: '',
                status: 'running' as const,
                files: [],
              }
            }]
          })
        },
        onCodeStdout: (content) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'code-execution') return item
              return { ...item, state: { ...item.state, stdout: item.state.stdout + content } }
            })
          })
        },
        onCodeStderr: (content) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'code-execution') return item
              return { ...item, state: { ...item.state, stderr: item.state.stderr + content } }
            })
          })
        },
        onCodeExecutionComplete: (data) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'code-execution') return item
              return {
                ...item,
                state: {
                  ...item.state,
                  status: 'completed' as const,
                  exitCode: data.exit_code,
                  executionTimeMs: data.execution_time_ms,
                  stdout: data.stdout || item.state.stdout,
                  stderr: data.stderr || item.state.stderr,
                  files: data.files,
                }
              }
            })
          })
        },
        onCodeExecutionError: (_executionId, error) => {
          setConversation(prev => {
            return prev.map(item => {
              if (item.type !== 'code-execution') return item
              return {
                ...item,
                state: { ...item.state, status: 'error' as const, error }
              }
            })
          })
        },
        onRedactionStatus: (stage) => {
          setRedactionStage(stage)
        },
        onCompactionStatus: async (event) => {
          // Backend has compacted some of the earlier turns. When a compaction
          // row was created, fetch the new row and append a marker so the user
          // can see what was summarized.
          if (event.action === 'failed') {
            // Compaction crashed server-side; the backend has best-effort
            // fallen back (Stage B window-drop) when possible, but operators
            // still want a signal in DevTools.
            console.error('[chat] compaction failed for thread', threadId)
            return
          }
          if (event.action === 'tool_prune') return  // succeeded, no marker
          if (!event.compaction_id) return
          try {
            const all = await getCompactions(threadId)
            const fresh = all.find(c => c.id === event.compaction_id)
            if (!fresh) return
            setConversation(prev => {
              if (prev.some(item => item.type === 'compaction' && item.id === `compaction-${fresh.id}`)) {
                return prev
              }
              // Slot the marker just before the streaming assistant text for the
              // current turn -- find the last user item and place after it.
              const insertAt = (() => {
                for (let i = prev.length - 1; i >= 0; i--) {
                  if (prev[i].type === 'user') return i + 1
                }
                return prev.length
              })()
              const marker: ConversationItem = {
                type: 'compaction',
                id: `compaction-${fresh.id}`,
                summary: fresh.summary_text,
                evictedCount: fresh.evicted_message_count,
                createdAt: fresh.created_at,
                modelUsed: fresh.model_used,
              }
              return [...prev.slice(0, insertAt), marker, ...prev.slice(insertAt)]
            })
          } catch (e) {
            console.warn('Failed to fetch new compaction row', e)
          }
        },
        onToolSearchResults: (data) => {
          console.log(`[ToolSearch] Loaded ${data.tools_loaded} tools:`, data.matches)
        },
        onTodosUpdated: (todos) => {
          if (isActiveThread() && onTodosUpdate) onTodosUpdate(todos)
        },
        onWorkspaceFileCreated: (file) => {
          if (isActiveThread() && onWorkspaceFileCreated) onWorkspaceFileCreated(file)
        },
        onWorkspaceFileUpdated: (file) => {
          if (isActiveThread() && onWorkspaceFileUpdated) onWorkspaceFileUpdated(file)
        },
        onAgentStatus: (status) => {
          if (onAgentStatusUpdate) onAgentStatusUpdate(status)
        },
        onUsage: (usage) => {
          setTokenUsage(usage)
          localStorage.setItem(`tokenUsage:${threadId}`, JSON.stringify(usage))
        },
        onHarnessPhaseStart: (phaseIndex, phaseName, phaseDescription) => {
          setWaiting(false)
          activeHarnessPhaseRef.current = phaseIndex
          const responseId = responseIdRef.current
          const phaseId = `${responseId}-harness-${phaseIndex}`
          setConversation(prev => [
            ...prev,
            {
              type: 'harness-phase' as const,
              id: phaseId,
              phase: {
                phaseIndex,
                phaseName,
                phaseDescription,
                status: 'running' as const,
                resultMarkdown: '',
                toolCalls: [],
              },
            },
          ])
        },
        onHarnessPhaseComplete: (phaseIndex, _phaseName, _resultSummary, resultMarkdown) => {
          const responseId = responseIdRef.current
          const phaseId = `${responseId}-harness-${phaseIndex}`
          setConversation(prev => prev.map(item => {
            if (item.id !== phaseId || item.type !== 'harness-phase') return item
            // Mark all remaining running tool calls as completed (safety net)
            const toolCalls = item.phase.toolCalls.map(tc =>
              tc.status === 'running' ? { ...tc, status: 'completed' as const } : tc
            )
            return { ...item, phase: { ...item.phase, status: 'completed' as const, toolCalls, resultMarkdown: resultMarkdown || item.phase.resultMarkdown } }
          }))
        },
        onHarnessAgentRound: (round, maxRounds) => {
          // Update the active phase with current agent round for progress visibility
          if (activeHarnessPhaseRef.current !== null) {
            const responseId = responseIdRef.current
            const phaseIdx = activeHarnessPhaseRef.current
            const phaseId = `${responseId}-harness-${phaseIdx}`
            setConversation(prev => prev.map(item =>
              item.id === phaseId && item.type === 'harness-phase'
                ? { ...item, phase: { ...item.phase, agentRound: round, agentMaxRounds: maxRounds } }
                : item
            ))
          }
        },
        onHarnessPhaseError: (phaseIndex, _phaseName, error) => {
          const responseId = responseIdRef.current
          const phaseId = `${responseId}-harness-${phaseIndex}`
          setConversation(prev => prev.map(item =>
            item.id === phaseId && item.type === 'harness-phase'
              ? { ...item, phase: { ...item.phase, status: 'error' as const, error } }
              : item
          ))
        },
        onHarnessComplete: (_harnessType, overallResult) => {
          activeHarnessPhaseRef.current = null
          // Advance text phase so post-harness summary text gets a new prefix
          // and doesn't clobber/reorder gatekeeper text items from phase 0.
          textPhaseRef.current += 1
          rawTextBufferRef.current = ''
          const responseId = responseIdRef.current
          setConversation(prev => [
            ...prev,
            {
              type: 'assistant-text' as const,
              id: `${responseId}-harness-done`,
              content: `**Analysis complete.** ${overallResult}`,
              messageKey: responseId,
            },
          ])
        },
        onHarnessSubAgentStart: (phaseIndex, subAgentId, clauseRef, description, _totalItems) => {
          const responseId = responseIdRef.current
          const phaseId = `${responseId}-harness-${phaseIndex}`
          setConversation(prev => prev.map(item => {
            if (item.id !== phaseId || item.type !== 'harness-phase') return item
            const subAgents = [...(item.phase.subAgents || [])]
            subAgents.push({ subAgentId, clauseRef, description, status: 'running', toolCalls: [] })
            return { ...item, phase: { ...item.phase, subAgents } }
          }))
        },
        onHarnessSubAgentToolCallStart: (subAgentId, _clauseRef, toolName, args) => {
          if (activeHarnessPhaseRef.current === null) return
          const responseId = responseIdRef.current
          const phaseId = `${responseId}-harness-${activeHarnessPhaseRef.current}`
          setConversation(prev => prev.map(item => {
            if (item.id !== phaseId || item.type !== 'harness-phase') return item
            const subAgents = (item.phase.subAgents || []).map(sa =>
              sa.subAgentId === subAgentId
                ? { ...sa, toolCalls: [...sa.toolCalls, { toolName, arguments: args, status: 'running' as const }] }
                : sa
            )
            return { ...item, phase: { ...item.phase, subAgents } }
          }))
        },
        onHarnessSubAgentToolCallComplete: (subAgentId, _clauseRef, toolName, result) => {
          if (activeHarnessPhaseRef.current === null) return
          const responseId = responseIdRef.current
          const phaseId = `${responseId}-harness-${activeHarnessPhaseRef.current}`
          setConversation(prev => prev.map(item => {
            if (item.id !== phaseId || item.type !== 'harness-phase') return item
            const subAgents = (item.phase.subAgents || []).map(sa => {
              if (sa.subAgentId !== subAgentId) return sa
              const toolCalls = sa.toolCalls.map(tc =>
                tc.toolName === toolName && tc.status === 'running'
                  ? { ...tc, status: 'completed' as const, result }
                  : tc
              )
              return { ...sa, toolCalls }
            })
            return { ...item, phase: { ...item.phase, subAgents } }
          }))
        },
        onHarnessSubAgentComplete: (subAgentId, _clauseRef, result) => {
          if (activeHarnessPhaseRef.current === null) return
          const responseId = responseIdRef.current
          const phaseId = `${responseId}-harness-${activeHarnessPhaseRef.current}`
          setConversation(prev => prev.map(item => {
            if (item.id !== phaseId || item.type !== 'harness-phase') return item
            const subAgents = (item.phase.subAgents || []).map(sa =>
              sa.subAgentId === subAgentId ? { ...sa, status: 'completed' as const, result } : sa
            )
            return { ...item, phase: { ...item.phase, subAgents } }
          }))
        },
        onHarnessBatchStart: (phaseIndex, batchIndex, batchSize, totalItems, processed) => {
          const responseId = responseIdRef.current
          const phaseId = `${responseId}-harness-${phaseIndex}`
          setConversation(prev => prev.map(item =>
            item.id === phaseId && item.type === 'harness-phase'
              ? { ...item, phase: { ...item.phase, batchProgress: { current: batchIndex, total: Math.ceil(totalItems / batchSize), processed } } }
              : item
          ))
        },
        onHarnessBatchComplete: (phaseIndex, _batchIndex, _resultsCount) => {
          const responseId = responseIdRef.current
          const phaseId = `${responseId}-harness-${phaseIndex}`
          setConversation(prev => prev.map(item => {
            if (item.id !== phaseId || item.type !== 'harness-phase') return item
            const bp = item.phase.batchProgress
            if (bp) {
              return { ...item, phase: { ...item.phase, batchProgress: { ...bp, processed: bp.processed + (item.phase.subAgents?.filter(sa => sa.status === 'completed').length || 0) } } }
            }
            return item
          }))
        },
        onHarnessHumanInputRequired: (phaseIndex, _phaseName) => {
          const responseId = responseIdRef.current
          const phaseId = `${responseId}-harness-${phaseIndex}`
          setConversation(prev => prev.map(item =>
            item.id === phaseId && item.type === 'harness-phase'
              ? { ...item, phase: { ...item.phase, isHumanInput: true, status: 'running' as const } }
              : item
          ))
        },
        onThreadTitle: (title) => {
          if (onThreadTitleUpdate) {
            onThreadTitleUpdate(threadId, title)
          }
        },
        onCitationAlias: ({ verification_mode, citations }) => {
          // Quick-mode inline citations: merge the streamed alias->source map
          // into the in-flight response's bucket so chips resolve as their
          // {[S#]} tokens stream in. Keyed by responseKey only -- the final
          // citation_metadata event handles the message_id binding and narrows
          // the bucket to cited-only (same citation_id, so no chip flicker).
          if (!citations || citations.length === 0) return
          const responseKey = responseIdRef.current
          if (!responseKey) return
          let mergedCitations: AnswerCitation[] = citations
          let mergedMode: CitationVerificationMode | null = verification_mode ?? null
          setCitationsByKey((prev) => {
            const existing = prev[responseKey]
            const byId = new Map<string, AnswerCitation>(
              (existing?.citations ?? []).map((c) => [c.citation_id, c]),
            )
            for (const c of citations) byId.set(c.citation_id, c)
            mergedCitations = Array.from(byId.values())
            mergedMode = verification_mode ?? existing?.mode ?? null
            return {
              ...prev,
              [responseKey]: {
                citations: mergedCitations,
                mode: mergedMode,
              },
            }
          })
          onCitationsUpdate?.(mergedCitations, mergedMode)
        },
        onCitationMetadata: ({ message_id, verification_mode, answer_text, citations }) => {
          const responseKey = responseIdRef.current
          const mode = verification_mode ?? null
          setCitationsByKey((prev) => {
            const next: Record<string, CitationBucket> = { ...prev }
            const bucket = { citations, mode }
            if (responseKey) next[responseKey] = bucket
            if (message_id) next[message_id] = bucket
            return next
          })
          if (responseKey) {
            // Migrate streaming items so subsequent reloads (without page refresh) keep the binding.
            // The finalize pass may rewrite the answer text (e.g. merged PDF citations); replace the draft in place.
            setConversation((prev) => {
              const nextKey = message_id ?? responseKey
              // answer_text is the normalized FINAL round's text: chat.py inserts
              // one message per round and only the last round's content_db_only is
              // carried here. Apply it to the LAST same-turn text segment. Replacing
              // the first segment and dropping the rest collapsed post-tool prose up
              // above the tool panel that preceded it (M6).
              let lastTextIndex = -1
              if (answer_text) {
                for (let i = prev.length - 1; i >= 0; i -= 1) {
                  const candidate = prev[i]
                  if (candidate.type === 'assistant-text' && candidate.messageKey === responseKey) {
                    lastTextIndex = i
                    break
                  }
                }
              }
              return prev.map((item, i) => {
                if (item.type !== 'assistant-text' || item.messageKey !== responseKey) return item
                if (answer_text && i === lastTextIndex) {
                  return { ...item, content: stripThinkTags(answer_text), messageKey: nextKey }
                }
                return { ...item, messageKey: nextKey }
              })
            })
          }
          onCitationsUpdate?.(citations, mode)
        },
        signal: abortController.signal,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setSending(false)
        setWaiting(false)
        setUploading(false)
        setRedactionStage(null)
        if (onAgentStatusUpdate) onAgentStatusUpdate(null)
      } else {
        console.error('Failed to send message:', err)
        setError((err as Error).message || 'Failed to send message')
        setSending(false)
        setWaiting(false)
        setUploading(false)
        setRedactionStage(null)
        if (onAgentStatusUpdate) onAgentStatusUpdate(null)
      }
      abortControllerRef.current = null
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if ((!input.trim() && pendingAttachments.length === 0) || sending || uploading) return
    const userMessage = input.trim()
    const attachments = pendingAttachments
    setInput('')
    setPendingAttachments([])
    await doSend(userMessage, attachments)
  }

  useEffect(() => {
    if (!loading && (initialMessage || (initialAttachments && initialAttachments.length > 0)) && !initialMessageSentRef.current) {
      initialMessageSentRef.current = true
      doSend(initialMessage ?? '', (initialAttachments ?? []).map(createPendingAttachment))
    }
  }, [loading, initialMessage, initialAttachments])

  const handleStop = () => {
    chatStreamStore.abort(threadId)
  }

  // Single-select composer mode shared by the "+" menu and the active-mode chip.
  const activeMode: ComposerMode = harnessMode
    ? (harnessMode as ComposerMode)
    : (deepMode ? 'general' : null)
  // Once a run exists on the thread (and didn't fail) the harness is committed —
  // the backend routes by it and rejects a second one, so lock the selector.
  const harnessLocked = !!harnessRun && harnessRun.status !== 'failed'

  const handleModeChange = (mode: ComposerMode) => {
    if (mode === null) {
      setDeepMode(false)
      setHarnessMode(null)
    } else if (mode === 'general') {
      setDeepMode(true)
      setHarnessMode(null)
    } else {
      setDeepMode(true)
      setHarnessMode(mode)
    }
  }

  const handleUploadFiles = useCallback((files: File[]) => {
    if (files.length === 0) return
    setPendingAttachments(prev => [
      ...prev,
      ...files.map(createPendingAttachment),
    ])
  }, [])

  const handleUpload = useCallback((file: File) => {
    handleUploadFiles([file])
  }, [handleUploadFiles])

  const handleRemoveAttachment = (id: string) => {
    setPendingAttachments(prev => {
      const attachment = prev.find(item => item.id === id)
      if (attachment) revokePendingAttachment(attachment)
      return prev.filter(item => item.id !== id)
    })
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFile = getPastedImageFile(e.clipboardData)
    if (!imageFile) return

    e.preventDefault()
    if (sending || uploading) return
    handleUpload(imageFile)
  }

  const { draggingFiles } = useFileDrop({
    disabled: loading || sending || uploading,
    onFiles: handleUploadFiles,
  })

  const hasPendingAttachments = pendingAttachments.length > 0

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <ChatFileDropOverlay visible={draggingFiles} />
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const hasContent = conversation.length > 0 || waiting || error
  const displayedConversation = groupSequentialToolItems(conversation)

  // Empty state - show centered welcome with integrated input
  if (!hasContent) {
    return (
      <div className="flex h-full flex-col items-center justify-center animate-fade-in">
        <ChatFileDropOverlay visible={draggingFiles} />
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold tracking-tight mb-1">What can I help with?</h1>
        </div>
        <form onSubmit={handleSubmit} className="w-full max-w-2xl px-4">
          <ActiveModeChip
            activeMode={activeMode}
            locked={harnessLocked}
            onClear={() => handleModeChange(null)}
          />
          <ComposerShell
            value={input}
            onChange={setInput}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit(e as unknown as React.FormEvent)
              }
            }}
            placeholder="Ask anything..."
            disabled={sending || uploading}
            inputRef={inputRef}
            attachmentsSlot={
              <AttachmentPreviewTray
                attachments={pendingAttachments}
                onRemove={handleRemoveAttachment}
                disabled={sending || uploading}
              />
            }
            activeMode={activeMode}
            onModeChange={handleModeChange}
            harnessLocked={harnessLocked}
            onUpload={handleUpload}
            uploading={uploading}
            showContextStats={!!tokenUsage}
            contextStatsOpen={isTokenUsageOpen}
            onToggleContextStats={() => setIsTokenUsageOpen(open => !open)}
            canSend={Boolean(input.trim()) || hasPendingAttachments}
          />
        </form>
      </div>
    )
  }

  const contextUsageRatio = tokenUsage ? tokenUsage.total_tokens / Math.max(contextWindow, 1) : 0
  const contextUsagePercent = Math.round(contextUsageRatio * 100)

  return (
    <div className="flex h-full flex-col">
      <ChatFileDropOverlay visible={draggingFiles} />
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto" ref={attachScrollContainer}>
        <div className="mx-auto max-w-3xl px-4 py-8">
            <div className="space-y-6">
              {displayedConversation.map((item, index) => {
                if (item.type === 'user') {
                  return (
                    <div key={item.id} className="flex justify-end animate-fade-in" style={{ animationDelay: `${index * 50}ms` }}>
                      <div className="flex w-full flex-col items-end">
                        <UserAttachments attachments={item.attachments} onFileClick={onFileClick} />
                        {item.content && (
                          <div className="max-w-[85%] rounded-2xl bg-surface-2 px-5 py-3 shadow-sm">
                            <p className="whitespace-pre-wrap">{item.content}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                }
                if (item.type === 'thinking') {
                  return (
                    <ThinkingPanel
                      key={item.id}
                      content={item.content}
                      isStreaming={item.isStreaming}
                    />
                  )
                }
                if (item.type === 'assistant-text') {
                  const messageKey = item.messageKey
                  const bucket = messageKey ? citationsByKey[messageKey] : undefined
                  const showActions = lastAssistantSegmentIds.has(item.id)
                  return (
                    <div key={item.id}>
                      <div className="prose prose-neutral dark:prose-invert max-w-none animate-fade-in prose-strong:font-medium">
                        <AssistantText
                          content={item.content}
                          citations={bucket?.citations}
                          verificationMode={bucket?.mode}
                          activeCitationId={activeCitationId}
                          onCitationClick={onCitationClick}
                        />
                      </div>
                      {showActions && (
                        <MessageActions
                          threadId={threadId}
                          messageId={messageKey}
                          content={assistantTextByKey.get(messageKey ?? item.id) ?? item.content}
                          hasCitations={!!bucket?.citations?.length}
                          citationsChecked={bucket?.mode === 'semantic-text'}
                          disabled={sending}
                          onCitationsChecked={(citations, mode) => {
                            if (!messageKey) return
                            chatStreamStore.updateCitations(threadId, (prev) => ({
                              ...prev,
                              [messageKey]: { citations, mode },
                            }))
                          }}
                        />
                      )}
                    </div>
                  )
                }
                if (item.type === 'tools') {
                  return <StepsPanel key={item.id} toolCalls={item.toolCalls} />
                }
                if (item.type === 'subagent') {
                  return <SubAgentPanel key={item.id} subAgent={item.state} />
                }
                if (item.type === 'code-execution') {
                  return <CodeExecutionPanel key={item.id} state={item.state} onFileClick={onFileClick} />
                }
                if (item.type === 'harness-phase') {
                  return <HarnessPhasePanel key={item.id} phase={item.phase} />
                }
                if (item.type === 'compaction') {
                  return (
                    <CompactionMarker
                      key={item.id}
                      evictedCount={item.evictedCount}
                      summary={item.summary}
                      createdAt={item.createdAt}
                      modelUsed={item.modelUsed}
                    />
                  )
                }
                return null
              })}

              {/* Redaction status indicator */}
              {redactionStage && (
                <div className="flex items-center gap-2 text-muted-foreground animate-fade-in">
                  <Shield className="h-3.5 w-3.5 animate-pulse" />
                  <span className="text-xs">
                    {redactionStage === 'anonymizing' ? 'Protecting PII...' : 'Restoring identities...'}
                  </span>
                </div>
              )}

              {/* Loading indicator */}
              {waiting && !redactionStage && (
                <div className="flex items-center gap-3 text-muted-foreground animate-fade-in">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <span className="text-sm">Thinking...</span>
                </div>
              )}

              {/* Error message */}
              {error && (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive animate-fade-in">
                  {error}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          </div>
      </div>

      {/* Input area */}
      <div className="border-t border-border/50 bg-surface-1 pb-safe">
        <Collapsible open={!!tokenUsage && isTokenUsageOpen} onOpenChange={setIsTokenUsageOpen}>
          {tokenUsage && (
            <CollapsibleContent id="context-usage-drawer">
              <div className="mx-auto max-w-3xl px-4 pt-2">
                <div className="rounded-lg border border-border/40 bg-background/40 px-3 py-3">
                  <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Context usage</span>
                    <span className="tabular-nums whitespace-nowrap">
                      {formatTokenCount(tokenUsage.total_tokens)} / {formatTokenCount(contextWindow)} ({contextUsagePercent}%)
                    </span>
                  </div>
                  <div
                    className="h-1.5 rounded-full bg-muted overflow-hidden"
                    role="progressbar"
                    aria-valuenow={tokenUsage.total_tokens}
                    aria-valuemin={0}
                    aria-valuemax={contextWindow}
                    aria-label={`Context window usage: ${contextUsagePercent}%`}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(contextUsageRatio * 100, 100)}%`,
                        backgroundColor: getUsageColor(contextUsageRatio),
                      }}
                    />
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          )}
          <div className="mx-auto max-w-3xl px-4 py-4">
            <form onSubmit={handleSubmit}>
              <ActiveModeChip
                activeMode={activeMode}
                locked={harnessLocked}
                onClear={() => handleModeChange(null)}
              />
              <ComposerShell
                value={input}
                onChange={setInput}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSubmit(e as unknown as React.FormEvent)
                  }
                }}
                placeholder="Ask anything..."
                disabled={sending || uploading}
                inputRef={inputRef}
                attachmentsSlot={
                  <AttachmentPreviewTray
                    attachments={pendingAttachments}
                    onRemove={handleRemoveAttachment}
                    disabled={sending || uploading}
                  />
                }
                activeMode={activeMode}
                onModeChange={handleModeChange}
                harnessLocked={harnessLocked}
                onUpload={handleUpload}
                uploading={uploading}
                showContextStats={!!tokenUsage}
                contextStatsOpen={isTokenUsageOpen}
                onToggleContextStats={() => setIsTokenUsageOpen(open => !open)}
                canSend={Boolean(input.trim()) || hasPendingAttachments}
                sending={sending}
                onStop={handleStop}
              />
            </form>
          </div>
        </Collapsible>
      </div>
    </div>
  )
}
