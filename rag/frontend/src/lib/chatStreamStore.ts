import { useSyncExternalStore } from 'react'
import type {
  ToolCallInfo,
  SubAgentState,
  CodeExecutionState,
  HarnessPhaseState,
  TokenUsage,
  AnswerCitation,
  CitationVerificationMode,
} from '@/types'

export interface ConversationAttachment {
  id: string
  fileName: string
  filePath?: string
  contentType: string
  sizeBytes: number
  previewUrl: string | null
}

// One ordered conversation item. Mirrors the union ChatView renders; kept here
// (not in the component) because the streaming store owns this state now and the
// component reads it back via useChatStreamSlice.
export type ConversationItem =
  | { type: 'user'; id: string; content: string; attachments?: ConversationAttachment[] }
  | { type: 'assistant-text'; id: string; content: string; messageKey?: string }
  | { type: 'thinking'; id: string; content: string; isStreaming: boolean }
  | { type: 'tools'; id: string; toolCalls: ToolCallInfo[] }
  | { type: 'subagent'; id: string; state: SubAgentState }
  | { type: 'code-execution'; id: string; state: CodeExecutionState }
  | { type: 'harness-phase'; id: string; phase: HarnessPhaseState }
  | { type: 'compaction'; id: string; summary: string; evictedCount: number; createdAt: string; modelUsed: string }

export interface CitationBucket {
  citations: AnswerCitation[]
  mode: CitationVerificationMode | null
}

export type StreamStatus = 'idle' | 'streaming' | 'done'

// Immutable per-thread render state. Replaced wholesale on every mutation so
// useSyncExternalStore sees a new reference and re-renders. A page reload clears
// the whole store (in-memory only) — that's the documented "navigation-only"
// boundary; the server persists the full answer on completion.
export interface ThreadStreamSlice {
  conversation: ConversationItem[]
  citationsByKey: Record<string, CitationBucket>
  sending: boolean
  waiting: boolean
  uploading: boolean
  error: string | null
  redactionStage: string | null
  tokenUsage: TokenUsage | null
  status: StreamStatus
}

// Mutable per-thread scratch the streaming callbacks poke at directly. Stable
// across renders/remounts (unlike a useRef, which a remount would reset), so a
// background stream keeps writing to the right place after you navigate away.
export interface ThreadScratch {
  responseId: string
  rawTextBuffer: string
  textPhase: number
  activeHarnessPhase: number | null
  toolGroupCounter: number
  abortController: AbortController | null
}

// Stable empty reference returned for threads with no slice yet. Must be the
// same object every call so useSyncExternalStore doesn't loop.
const EMPTY_SLICE: ThreadStreamSlice = Object.freeze({
  conversation: [],
  citationsByKey: {},
  sending: false,
  waiting: false,
  uploading: false,
  error: null,
  redactionStage: null,
  tokenUsage: null,
  status: 'idle',
}) as ThreadStreamSlice

const slices = new Map<string, ThreadStreamSlice>()
const scratches = new Map<string, ThreadScratch>()
const listeners = new Set<() => void>()

// Which thread the user is currently viewing. Background streams use this to
// gate side effects that mutate the parent's (active-thread) UI — todos,
// workspace files — so a stream finishing off-screen can't clobber the view.
let activeThreadId: string | null = null

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSlice(threadId: string): ThreadStreamSlice {
  return slices.get(threadId) ?? EMPTY_SLICE
}

export function getStatus(threadId: string): StreamStatus {
  return (slices.get(threadId) ?? EMPTY_SLICE).status
}

/** Shallow-merge a partial into a thread's slice. `sending` drives `status`. */
export function patch(threadId: string, partial: Partial<ThreadStreamSlice>): void {
  const cur = slices.get(threadId) ?? EMPTY_SLICE
  const next: ThreadStreamSlice = { ...cur, ...partial }
  if (Object.prototype.hasOwnProperty.call(partial, 'sending')) {
    next.status = partial.sending ? 'streaming' : 'done'
  }
  slices.set(threadId, next)
  emit()
}

export function updateConversation(
  threadId: string,
  updater: (prev: ConversationItem[]) => ConversationItem[],
): void {
  const cur = slices.get(threadId) ?? EMPTY_SLICE
  slices.set(threadId, { ...cur, conversation: updater(cur.conversation) })
  emit()
}

export function setConversation(threadId: string, conversation: ConversationItem[]): void {
  const cur = slices.get(threadId) ?? EMPTY_SLICE
  slices.set(threadId, { ...cur, conversation })
  emit()
}

export function updateCitations(
  threadId: string,
  updater: (prev: Record<string, CitationBucket>) => Record<string, CitationBucket>,
): void {
  const cur = slices.get(threadId) ?? EMPTY_SLICE
  slices.set(threadId, { ...cur, citationsByKey: updater(cur.citationsByKey) })
  emit()
}

export function setCitations(threadId: string, citationsByKey: Record<string, CitationBucket>): void {
  const cur = slices.get(threadId) ?? EMPTY_SLICE
  slices.set(threadId, { ...cur, citationsByKey })
  emit()
}

/** Update token usage in the slice and mirror it to localStorage (per thread). */
export function setTokenUsage(threadId: string, usage: TokenUsage | null): void {
  patch(threadId, { tokenUsage: usage })
  try {
    if (usage) localStorage.setItem(`tokenUsage:${threadId}`, JSON.stringify(usage))
  } catch {
    /* ignore */
  }
}

export function getScratch(threadId: string): ThreadScratch {
  let s = scratches.get(threadId)
  if (!s) {
    s = {
      responseId: '',
      rawTextBuffer: '',
      textPhase: 0,
      activeHarnessPhase: null,
      toolGroupCounter: 0,
      abortController: null,
    }
    scratches.set(threadId, s)
  }
  return s
}

/** Abort a thread's in-flight stream (Stop button). */
export function abort(threadId: string): void {
  const sc = scratches.get(threadId)
  if (sc?.abortController) {
    sc.abortController.abort()
    sc.abortController = null
  }
}

/**
 * Forget a thread's streaming state so the next render reloads from the DB.
 * Called when re-entering a thread whose stream already finished (status
 * 'done'): the answer is persisted, so the DB is the source of truth again.
 */
export function reset(threadId: string): void {
  slices.delete(threadId)
  scratches.delete(threadId)
  emit()
}

export function getActiveThread(): string | null {
  return activeThreadId
}

export function setActiveThread(threadId: string | null): void {
  // No emit: callers read this imperatively; it doesn't affect rendered slices.
  activeThreadId = threadId
}

/** Subscribe a component to one thread's slice. */
export function useChatStreamSlice(threadId: string): ThreadStreamSlice {
  return useSyncExternalStore(
    subscribe,
    () => getSlice(threadId),
  )
}

// Grouped export so call sites read `chatStreamStore.x` — easy to scan and to
// stub in tests.
export const chatStreamStore = {
  getSlice,
  getStatus,
  patch,
  updateConversation,
  setConversation,
  updateCitations,
  setCitations,
  setTokenUsage,
  getScratch,
  abort,
  reset,
  getActiveThread,
  setActiveThread,
}
