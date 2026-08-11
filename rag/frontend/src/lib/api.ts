import { supabase } from './supabase'
import type { Thread, Message, Document, Folder, Skill, SkillFile, SkillFileContent, SkillImportResponse, TokenUsage, TodoItem, AgentStatus, WorkspaceFile, Compaction, CompactionStatusEvent, AnswerCitation, CitationVerificationMode } from '@/types'

const API_URL = import.meta.env.VITE_API_URL
const DOCUMENT_DIRECT_FALLBACK_DELAY_MS = 800

async function getAuthHeaders(): Promise<HeadersInit> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new Error('Not authenticated')
  }
  return {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  }
}

export async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = await getAuthHeaders()
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(error.detail || 'Request failed')
  }

  return response.json()
}

async function runWithDocumentDirectFallback<T>(
  primary: Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let fallbackPromise: Promise<T> | null = null

  const getFallback = () => {
    fallbackPromise = fallbackPromise ?? fallback()
    return fallbackPromise
  }

  const delayedFallback = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      getFallback().then(resolve).catch(() => {
        // If the direct client path cannot see this document (for example a
        // shared/global document), keep waiting for the backend route.
      })
    }, DOCUMENT_DIRECT_FALLBACK_DELAY_MS)
  })

  try {
    return await Promise.race([primary, delayedFallback])
  } catch (error) {
    try {
      return await getFallback()
    } catch {
      throw error
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// LLM model picker — models available for the env-configured provider.
export interface AvailableModelsResponse {
  provider: string
  models: { id: string }[]
  error?: string | null
}

let _modelsCache: Promise<AvailableModelsResponse> | null = null

export async function getAvailableModels(force = false): Promise<AvailableModelsResponse> {
  if (force) _modelsCache = null
  if (!_modelsCache) {
    _modelsCache = fetchApi<AvailableModelsResponse>('/settings/models').catch((err) => {
      _modelsCache = null // allow a retry on the next dialog open
      throw err
    })
  }
  return _modelsCache
}

// Thread API
export interface PaginatedThreadsResponse {
  threads: Thread[]
  total_count: number
  has_more: boolean
}

export interface ListThreadsOptions {
  search?: string
  offset?: number
  limit?: number
}

export async function listThreads(
  options: ListThreadsOptions = {}
): Promise<PaginatedThreadsResponse> {
  const { search, offset = 0, limit = 50 } = options
  const params = new URLSearchParams()
  if (search && search.trim()) params.set('search', search.trim())
  params.set('offset', String(offset))
  params.set('limit', String(limit))
  return fetchApi<PaginatedThreadsResponse>(`/threads?${params.toString()}`)
}

export async function createThread(title?: string): Promise<Thread> {
  return fetchApi<Thread>('/threads', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export async function getThread(threadId: string): Promise<Thread> {
  return fetchApi<Thread>(`/threads/${threadId}`)
}

export async function updateThread(threadId: string, title: string): Promise<Thread> {
  return fetchApi<Thread>(`/threads/${threadId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export async function deleteThread(threadId: string): Promise<void> {
  const headers = await getAuthHeaders()
  const response = await fetch(`${API_URL}/threads/${threadId}`, {
    method: 'DELETE',
    headers,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(error.detail || 'Request failed')
  }
}

// Messages API
export async function getMessages(threadId: string): Promise<Message[]> {
  return fetchApi<Message[]>(`/threads/${threadId}/messages`)
}

export interface CheckCitationsResult {
  message_id: string
  verification_mode: CitationVerificationMode | null
  citations: AnswerCitation[]
}

/**
 * Run the on-demand grounding check ("Check Citations") for one assistant
 * message. The backend grades each citation against its cited source and
 * returns the refreshed citations (now in `semantic-text` mode) so the inline
 * chips can be recolored.
 */
export async function checkCitations(
  threadId: string,
  messageId: string,
): Promise<CheckCitationsResult> {
  return fetchApi<CheckCitationsResult>(
    `/threads/${threadId}/messages/${messageId}/check-citations`,
    { method: 'POST' },
  )
}

export interface SendMessageOptions {
  threadId: string
  content: string
  deepMode?: boolean
  harnessMode?: string
  /** Per-message model override (UI-selected). '' / undefined = server default. */
  model?: string
  /** Enable provider reasoning ("thinking") for this message. */
  thinking?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** Workspace files uploaded as part of this send and attached to the prompt. */
  attachmentFilePaths?: string[]
  onTextDelta: (text: string) => void
  onDone: () => void
  onError: (error: string) => void
  onToolCallPending?: (toolName: string) => void
  onToolCallDelta?: (toolName: string, argumentsDelta: string) => void
  onToolCallStart?: (toolName: string, args: string, toolCallId?: string) => void
  onToolCallComplete?: (toolName: string, resultSummary?: string, result?: string, toolCallId?: string) => void
  onSubAgentStart?: (documentId: string, filename: string) => void
  onSubAgentReasoning?: (content: string) => void
  onSubAgentComplete?: (result: string) => void
  onSubAgentError?: (error: string) => void
  onTaskSubAgentStart?: (subAgentId: string, description: string) => void
  onTaskSubAgentProgress?: (subAgentId: string, content: string) => void
  onTaskSubAgentComplete?: (subAgentId: string, result: string) => void
  onTaskSubAgentError?: (subAgentId: string, error: string) => void
  onTaskSubAgentToolStart?: (subAgentId: string, toolName: string, args: string) => void
  onTaskSubAgentToolComplete?: (subAgentId: string, toolName: string, resultSummary: string) => void
  onExplorerStart?: (researchQuery: string, startingPath: string) => void
  onExplorerToolCall?: (toolName: string, args: Record<string, any>, round: number) => void
  onExplorerToolResult?: (toolName: string, resultSummary: string) => void
  onExplorerReasoning?: (content: string) => void
  onExplorerComplete?: (findings: string) => void
  onExplorerError?: (error: string) => void
  onThreadTitle?: (title: string) => void
  onRedactionStatus?: (stage: string) => void
  onCompactionStatus?: (event: CompactionStatusEvent) => void
  onCodeExecutionStart?: (executionId: string, language: string, codePreview: string) => void
  onCodeStdout?: (content: string) => void
  onCodeStderr?: (content: string) => void
  onCodeExecutionComplete?: (data: { execution_id: string; exit_code: number; execution_time_ms: number; stdout: string; stderr: string; files: Array<{ filename: string; download_url: string; file_size: number; content_type: string; error?: string }> }) => void
  onCodeExecutionError?: (executionId: string, error: string) => void
  onSkillActivated?: (data: { skill_id: string; skill_name: string }) => void
  onToolSearchResults?: (data: { query: string; matches: string[]; tools_loaded: number }) => void
  onTodosUpdated?: (todos: TodoItem[]) => void
  onWorkspaceFileCreated?: (file: WorkspaceFile) => void
  onWorkspaceFileUpdated?: (file: WorkspaceFile) => void
  onAgentStatus?: (status: AgentStatus) => void
  onUsage?: (usage: TokenUsage) => void
  onHarnessPhaseStart?: (phaseIndex: number, phaseName: string, phaseDescription: string) => void
  onHarnessPhaseComplete?: (phaseIndex: number, phaseName: string, resultSummary: string, resultMarkdown?: string) => void
  onHarnessPhaseError?: (phaseIndex: number, phaseName: string, error: string) => void
  onHarnessAgentRound?: (round: number, maxRounds: number) => void
  onHarnessComplete?: (harnessType: string, overallResult: string) => void
  onHarnessSubAgentStart?: (phaseIndex: number, subAgentId: string, clauseRef: string, description: string, totalItems: number) => void
  onHarnessSubAgentToolCallStart?: (subAgentId: string, clauseRef: string, toolName: string, args: string) => void
  onHarnessSubAgentToolCallComplete?: (subAgentId: string, clauseRef: string, toolName: string, result: string) => void
  onHarnessSubAgentComplete?: (subAgentId: string, clauseRef: string, result: string) => void
  onHarnessBatchStart?: (phaseIndex: number, batchIndex: number, batchSize: number, totalItems: number, processed: number) => void
  onHarnessBatchComplete?: (phaseIndex: number, batchIndex: number, resultsCount: number) => void
  onHarnessHumanInputRequired?: (phaseIndex: number, phaseName: string) => void
  onCitationMetadata?: (data: {
    message_id?: string
    verification_mode: CitationVerificationMode | null
    answer_text?: string
    citations: AnswerCitation[]
  }) => void
  // Quick-mode only: incremental alias->source map streamed as tools register
  // citable spans, so chips can render inline before the answer completes.
  onCitationAlias?: (data: {
    verification_mode: CitationVerificationMode | null
    citations: AnswerCitation[]
  }) => void
  signal?: AbortSignal
}

export async function sendMessage(options: SendMessageOptions): Promise<void> {
  const {
    threadId,
    content,
    deepMode,
    harnessMode,
    model,
    thinking,
    reasoningEffort,
    attachmentFilePaths,
    onTextDelta,
    onDone,
    onError,
    onToolCallPending,
    onToolCallDelta,
    onToolCallStart,
    onToolCallComplete,
    onSubAgentStart,
    onSubAgentReasoning,
    onSubAgentComplete,
    onSubAgentError,
    onTaskSubAgentStart,
    onTaskSubAgentProgress,
    onTaskSubAgentComplete,
    onTaskSubAgentError,
    onTaskSubAgentToolStart,
    onTaskSubAgentToolComplete,
    onExplorerStart,
    onExplorerToolCall,
    onExplorerToolResult,
    onExplorerReasoning,
    onExplorerComplete,
    onExplorerError,
    onThreadTitle,
    onRedactionStatus,
    onCompactionStatus,
    onCodeExecutionStart,
    onCodeStdout,
    onCodeStderr,
    onCodeExecutionComplete,
    onCodeExecutionError,
    onSkillActivated,
    onToolSearchResults,
    onTodosUpdated,
    onWorkspaceFileCreated,
    onWorkspaceFileUpdated,
    onAgentStatus,
    onUsage,
    onHarnessPhaseStart,
    onHarnessPhaseComplete,
    onHarnessPhaseError,
    onHarnessAgentRound,
    onHarnessComplete,
    onHarnessSubAgentStart,
    onHarnessSubAgentToolCallStart,
    onHarnessSubAgentToolCallComplete,
    onHarnessSubAgentComplete,
    onHarnessBatchStart,
    onHarnessBatchComplete,
    onHarnessHumanInputRequired,
    onCitationMetadata,
    onCitationAlias,
    signal,
  } = options

  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new Error('Not authenticated')
  }

  const response = await fetch(`${API_URL}/threads/${threadId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content,
      deep_mode: deepMode || false,
      harness_mode: harnessMode || null,
      model: model || null,
      thinking: thinking || false,
      reasoning_effort: thinking ? (reasoningEffort || 'medium') : null,
      attachment_file_paths: attachmentFilePaths || [],
    }),
    signal,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(error.detail || 'Request failed')
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('No response body')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          const eventType = line.slice(7).trim()
          if (eventType === 'done') {
            onDone()
          }
          continue
        }
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          try {
            const parsed = JSON.parse(data)

            // Handle events by type
            switch (parsed.type) {
              case 'tool_call_pending':
                if (onToolCallPending) {
                  onToolCallPending(parsed.tool_name)
                }
                break
              case 'tool_call_delta':
                if (onToolCallDelta) {
                  onToolCallDelta(parsed.tool_name, parsed.arguments_delta || '')
                }
                break
              case 'tool_call_start':
                if (parsed.sub_agent_id && onTaskSubAgentToolStart) {
                  onTaskSubAgentToolStart(parsed.sub_agent_id, parsed.tool_name, parsed.arguments || '')
                } else if (onToolCallStart) {
                  onToolCallStart(parsed.tool_name, parsed.arguments || '', parsed.tool_call_id)
                }
                break
              case 'tool_call_complete':
                if (parsed.sub_agent_id && onTaskSubAgentToolComplete) {
                  onTaskSubAgentToolComplete(parsed.sub_agent_id, parsed.tool_name, parsed.result_summary || '')
                } else if (onToolCallComplete) {
                  // Skip for sub-agent tools — their step lifecycle is managed by
                  // sub_agent_start/complete handlers. Calling onToolCallComplete here
                  // would match the wrong running entry when multiple parallel calls exist.
                  // BUT: harness tool calls have tool_call_id and must always be forwarded.
                  const subAgentTools = ['task', 'analyze_document', 'explore_knowledge_base']
                  if (parsed.tool_call_id || !subAgentTools.includes(parsed.tool_name)) {
                    onToolCallComplete(parsed.tool_name, parsed.result_summary, parsed.result, parsed.tool_call_id)
                  }
                }
                break
              case 'sub_agent_start':
                if (parsed.sub_agent_id) {
                  // Task sub-agent (has sub_agent_id, no document_id)
                  if (onTaskSubAgentStart) {
                    onTaskSubAgentStart(parsed.sub_agent_id, parsed.description || '')
                  }
                } else if (onSubAgentStart) {
                  // Analyze sub-agent (has document_id)
                  onSubAgentStart(parsed.document_id, parsed.filename)
                }
                break
              case 'sub_agent_reasoning':
                if (onSubAgentReasoning) {
                  onSubAgentReasoning(parsed.content)
                }
                break
              case 'sub_agent_complete':
                if (parsed.sub_agent_id) {
                  if (onTaskSubAgentComplete) {
                    onTaskSubAgentComplete(parsed.sub_agent_id, parsed.result || '')
                  }
                } else if (onSubAgentComplete) {
                  onSubAgentComplete(parsed.result)
                }
                break
              case 'sub_agent_error':
                if (parsed.sub_agent_id && onTaskSubAgentError) {
                  onTaskSubAgentError(parsed.sub_agent_id, parsed.error)
                } else if (onSubAgentError) {
                  onSubAgentError(parsed.error)
                }
                break
              case 'error':
                if (parsed.sub_agent_id && onTaskSubAgentError) {
                  onTaskSubAgentError(parsed.sub_agent_id, parsed.error)
                } else if (parsed.error) {
                  onError(parsed.error)
                }
                break
              case 'text_delta':
                if (parsed.sub_agent_id && onTaskSubAgentProgress) {
                  onTaskSubAgentProgress(parsed.sub_agent_id, parsed.content || '')
                } else if (parsed.content) {
                  onTextDelta(parsed.content)
                }
                break
              case 'explorer_start':
                if (onExplorerStart) {
                  onExplorerStart(parsed.research_query, parsed.starting_path)
                }
                break
              case 'explorer_tool_call':
                if (onExplorerToolCall) {
                  onExplorerToolCall(parsed.tool_name, parsed.arguments || {}, parsed.round || 0)
                }
                break
              case 'explorer_tool_result':
                if (onExplorerToolResult) {
                  onExplorerToolResult(parsed.tool_name, parsed.result_summary || '')
                }
                break
              case 'explorer_reasoning':
                if (onExplorerReasoning) {
                  onExplorerReasoning(parsed.content)
                }
                break
              case 'explorer_complete':
                if (onExplorerComplete) {
                  onExplorerComplete(parsed.findings)
                }
                break
              case 'explorer_error':
                if (onExplorerError) {
                  onExplorerError(parsed.error)
                }
                break
              case 'redaction_status':
                if (onRedactionStatus) {
                  onRedactionStatus(parsed.stage)
                }
                break
              case 'compaction_status':
                if (onCompactionStatus) {
                  onCompactionStatus({
                    action: parsed.action,
                    compaction_id: parsed.compaction_id ?? null,
                  })
                }
                break
              case 'code_execution_start':
                if (onCodeExecutionStart) {
                  onCodeExecutionStart(parsed.execution_id, parsed.language, parsed.code_preview)
                }
                break
              case 'code_stdout':
                if (onCodeStdout) {
                  onCodeStdout(parsed.content)
                }
                break
              case 'code_stderr':
                if (onCodeStderr) {
                  onCodeStderr(parsed.content)
                }
                break
              case 'code_execution_complete':
                if (onCodeExecutionComplete) {
                  onCodeExecutionComplete({
                    execution_id: parsed.execution_id,
                    exit_code: parsed.exit_code,
                    execution_time_ms: parsed.execution_time_ms,
                    stdout: parsed.stdout || '',
                    stderr: parsed.stderr || '',
                    files: parsed.files || [],
                  })
                }
                break
              case 'code_execution_error':
                if (onCodeExecutionError) {
                  onCodeExecutionError(parsed.execution_id, parsed.error)
                }
                break
              case 'skill_activated':
                if (onSkillActivated) {
                  onSkillActivated({ skill_id: parsed.skill_id, skill_name: parsed.skill_name })
                }
                break
              case 'tool_search_results':
                if (onToolSearchResults) {
                  onToolSearchResults({ query: parsed.query, matches: parsed.matches || [], tools_loaded: parsed.tools_loaded || 0 })
                }
                break
              case 'usage':
                if (onUsage) {
                  onUsage({ prompt_tokens: parsed.prompt_tokens, completion_tokens: parsed.completion_tokens, total_tokens: parsed.total_tokens })
                }
                break
              case 'todos_updated':
                if (onTodosUpdated) {
                  onTodosUpdated(parsed.todos)
                }
                break
              case 'workspace_file_created':
                if (onWorkspaceFileCreated) {
                  onWorkspaceFileCreated({
                    id: parsed.id,
                    thread_id: parsed.thread_id,
                    file_path: parsed.file_path,
                    size_bytes: parsed.size_bytes,
                    content_type: parsed.content_type,
                    source: parsed.source,
                    storage_path: parsed.storage_path ?? null,
                    created_at: parsed.created_at ?? '',
                    updated_at: parsed.updated_at ?? '',
                  })
                }
                break
              case 'workspace_file_updated':
                if (onWorkspaceFileUpdated) {
                  onWorkspaceFileUpdated({
                    id: parsed.id,
                    thread_id: parsed.thread_id,
                    file_path: parsed.file_path,
                    size_bytes: parsed.size_bytes,
                    content_type: parsed.content_type,
                    source: parsed.source,
                    storage_path: parsed.storage_path ?? null,
                    created_at: parsed.created_at ?? '',
                    updated_at: parsed.updated_at ?? '',
                  })
                }
                break
              case 'agent_status':
                if (onAgentStatus) {
                  onAgentStatus(parsed.status)
                }
                break
              case 'thread_title':
                if (onThreadTitle) {
                  onThreadTitle(parsed.title)
                }
                break
              case 'harness_phase_start':
                if (onHarnessPhaseStart) {
                  onHarnessPhaseStart(parsed.phase_index, parsed.phase_name, parsed.phase_description)
                }
                break
              case 'harness_phase_complete':
                if (onHarnessPhaseComplete) {
                  onHarnessPhaseComplete(parsed.phase_index, parsed.phase_name, parsed.result_summary, parsed.result_markdown)
                }
                break
              case 'harness_phase_error':
                if (onHarnessPhaseError) {
                  onHarnessPhaseError(parsed.phase_index, parsed.phase_name, parsed.error)
                }
                break
              case 'agent_round':
                if (onHarnessAgentRound) {
                  onHarnessAgentRound(parsed.round, parsed.max_rounds)
                }
                break
              case 'harness_complete':
                if (onHarnessComplete) {
                  onHarnessComplete(parsed.harness_type, parsed.overall_result)
                }
                break
              case 'harness_phase_result':
                // Phase result data — consumed by harness engine, no frontend action needed
                break
              case 'harness_sub_agent_start':
                if (onHarnessSubAgentStart) {
                  onHarnessSubAgentStart(parsed.phase_index, parsed.sub_agent_id, parsed.clause_ref, parsed.description, parsed.total_items)
                }
                break
              case 'harness_sub_agent_tool_call_start':
                if (onHarnessSubAgentToolCallStart) {
                  onHarnessSubAgentToolCallStart(parsed.sub_agent_id, parsed.clause_ref, parsed.tool_name, parsed.arguments || '')
                }
                break
              case 'harness_sub_agent_tool_call_complete':
                if (onHarnessSubAgentToolCallComplete) {
                  onHarnessSubAgentToolCallComplete(parsed.sub_agent_id, parsed.clause_ref, parsed.tool_name, parsed.result || '')
                }
                break
              case 'harness_sub_agent_complete':
                if (onHarnessSubAgentComplete) {
                  onHarnessSubAgentComplete(parsed.sub_agent_id, parsed.clause_ref, parsed.result || '')
                }
                break
              case 'harness_batch_start':
                if (onHarnessBatchStart) {
                  onHarnessBatchStart(parsed.phase_index, parsed.batch_index, parsed.batch_size, parsed.total_items, parsed.processed)
                }
                break
              case 'harness_batch_complete':
                if (onHarnessBatchComplete) {
                  onHarnessBatchComplete(parsed.phase_index, parsed.batch_index, parsed.results_count)
                }
                break
              case 'harness_human_input_required':
                if (onHarnessHumanInputRequired) {
                  onHarnessHumanInputRequired(parsed.phase_index, parsed.phase_name)
                }
                break
              case 'citation_metadata':
                if (onCitationMetadata) {
                  onCitationMetadata({
                    message_id: parsed.message_id,
                    verification_mode: parsed.verification_mode ?? null,
                    answer_text: parsed.answer_text,
                    citations: parsed.citations ?? [],
                  })
                }
                break
              case 'citation_alias':
                if (onCitationAlias) {
                  onCitationAlias({
                    verification_mode: parsed.verification_mode ?? null,
                    citations: parsed.citations ?? [],
                  })
                }
                break
              default:
                // Text delta (no type field)
                if (parsed.content) {
                  onTextDelta(parsed.content)
                }
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// Todos API (Deep Mode)
export async function getTodos(threadId: string): Promise<TodoItem[]> {
  return fetchApi<TodoItem[]>(`/threads/${threadId}/todos`)
}

// Documents API
export async function uploadDocument(file: File, folderId?: string | null): Promise<Document> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new Error('Not authenticated')
  }

  const formData = new FormData()
  formData.append('file', file)
  if (folderId) {
    formData.append('folder_id', folderId)
  }

  const response = await fetch(`${API_URL}/documents/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Upload failed' }))
    throw new Error(error.detail || 'Upload failed')
  }

  return response.json()
}

export interface UploadedWorkspaceFile {
  id: string
  file_path: string
  content_type: string
  size_bytes: number
  storage_path: string | null
}

// Upload a file into a thread's workspace so the agent can read it via the
// list_files/read_file tools. Available in any chat (not just harness mode).
export async function uploadWorkspaceFile(threadId: string, file: File): Promise<UploadedWorkspaceFile> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new Error('Not authenticated')
  }

  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(`${API_URL}/threads/${threadId}/files/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Upload failed' }))
    throw new Error(error.detail || `Upload failed: ${response.status}`)
  }

  return response.json()
}

export interface PaginatedDocumentsResponse {
  documents: Document[]
  total_count: number
  has_more: boolean
}

export interface ListDocumentsOptions {
  folderId?: string | null
  offset?: number
  limit?: number
}

export async function listDocuments(options: ListDocumentsOptions = {}): Promise<PaginatedDocumentsResponse> {
  const { folderId, offset = 0, limit = 50 } = options
  const params = new URLSearchParams()
  // When folderId is explicitly null, use "unfiled" to filter documents without a folder
  if (folderId === null) {
    params.set('folder_id', 'unfiled')
  } else if (folderId) {
    params.set('folder_id', folderId)
  }
  params.set('offset', String(offset))
  params.set('limit', String(limit))
  const query = `?${params.toString()}`
  return fetchApi<PaginatedDocumentsResponse>(`/documents${query}`)
}

export interface SearchDocumentsOptions {
  query: string
  limit?: number
}

// Hybrid (content + filename) search across all of the user's documents, regardless of folder.
// Returns documents ranked by relevance (filename matches first, then content matches).
export async function searchDocuments(options: SearchDocumentsOptions): Promise<PaginatedDocumentsResponse> {
  const { query, limit = 50 } = options
  const params = new URLSearchParams()
  params.set('q', query)
  params.set('limit', String(limit))
  return fetchApi<PaginatedDocumentsResponse>(`/documents/search?${params.toString()}`)
}

export async function getDocument(documentId: string): Promise<Document> {
  return fetchApi<Document>(`/documents/${documentId}`)
}

export async function retryDocument(documentId: string): Promise<Document> {
  return fetchApi<Document>(`/documents/${documentId}/retry`, {
    method: 'POST',
  })
}

export async function getDocumentDownloadUrl(documentId: string): Promise<{ url: string; file_type: string }> {
  return runWithDocumentDirectFallback(
    fetchApi<{ url: string; file_type: string }>(`/documents/${documentId}/download`),
    () => getDocumentDownloadUrlDirect(documentId),
  )
}

export interface DocumentRenderPage {
  page_no: number
  markdown: string
}

export interface DocumentStructureNode {
  id: string
  kind: 'page' | 'section'
  title: string
  level: number
  page_no?: number | null
  bbox?: Record<string, unknown>
  chunk_range?: number[]
  chunk_count?: number
  mapped_chunk_index?: number
  hierarchy_path?: string
}

export interface DocumentStructure {
  version: number
  source: string
  nodes: DocumentStructureNode[]
}

export interface DocumentRender {
  document_id: string
  markdown: string | null
  pages: DocumentRenderPage[]
  structure: DocumentStructure | null
}

export async function getDocumentRender(documentId: string): Promise<DocumentRender> {
  return runWithDocumentDirectFallback(
    fetchApi<DocumentRender>(`/documents/${documentId}/render`),
    () => getDocumentRenderDirect(documentId),
  )
}

export interface ChunkInfo {
  id: string
  content: string
  chunk_index: number
  metadata: Record<string, unknown> | null
}

export async function getDocumentChunks(documentId: string): Promise<ChunkInfo[]> {
  return runWithDocumentDirectFallback(
    fetchApi<ChunkInfo[]>(`/documents/${documentId}/chunks`),
    () => getDocumentChunksDirect(documentId),
  )
}

async function getDocumentDownloadUrlDirect(documentId: string): Promise<{ url: string; file_type: string }> {
  const { data, error } = await supabase
    .from('documents')
    .select('storage_path,file_type')
    .eq('id', documentId)
    .maybeSingle()

  if (error || !data?.storage_path) {
    throw error ?? new Error('Document not found')
  }

  const signed = await supabase.storage
    .from('documents')
    .createSignedUrl(data.storage_path, 3600)

  if (signed.error || !signed.data?.signedUrl) {
    throw signed.error ?? new Error('Failed to generate download URL')
  }

  return { url: signed.data.signedUrl, file_type: data.file_type || 'application/octet-stream' }
}

async function getDocumentRenderDirect(documentId: string): Promise<DocumentRender> {
  const { data, error } = await supabase
    .from('documents')
    .select('id,full_markdown,document_pages,document_structure')
    .eq('id', documentId)
    .maybeSingle()

  if (error || !data) {
    throw error ?? new Error('Document not found')
  }

  return {
    document_id: data.id,
    markdown: typeof data.full_markdown === 'string' ? data.full_markdown : null,
    pages: Array.isArray(data.document_pages) ? data.document_pages as DocumentRenderPage[] : [],
    structure: data.document_structure as DocumentStructure | null,
  }
}

async function getDocumentChunksDirect(documentId: string): Promise<ChunkInfo[]> {
  const { data, error } = await supabase
    .from('chunks')
    .select('id,content,chunk_index,metadata')
    .eq('document_id', documentId)
    .order('chunk_index')

  if (error) throw error
  return (data ?? []) as ChunkInfo[]
}

export async function deleteDocument(documentId: string): Promise<void> {
  const headers = await getAuthHeaders()
  const response = await fetch(`${API_URL}/documents/${documentId}`, {
    method: 'DELETE',
    headers,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Delete failed' }))
    throw new Error(error.detail || 'Delete failed')
  }
}

export interface BulkActionResult {
  succeeded: string[]
  failed: string[]
}

export async function bulkDeleteDocuments(documentIds: string[]): Promise<BulkActionResult> {
  return fetchApi<BulkActionResult>('/documents/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ document_ids: documentIds }),
  })
}

export async function bulkMoveDocuments(
  documentIds: string[],
  folderId: string | null,
): Promise<BulkActionResult> {
  return fetchApi<BulkActionResult>('/documents/bulk-move', {
    method: 'POST',
    body: JSON.stringify({ document_ids: documentIds, folder_id: folderId }),
  })
}

// Folders API
export async function listFolders(parentId?: string | null): Promise<Folder[]> {
  const params = new URLSearchParams()
  if (parentId) {
    params.set('parent_id', parentId)
  }
  const query = params.toString() ? `?${params.toString()}` : ''
  return fetchApi<Folder[]>(`/folders${query}`)
}

// Returns every visible folder (own + global) as a flat list, regardless of
// nesting — used to build folder pickers like the bulk "move to folder" dialog.
export async function listAllFolders(): Promise<Folder[]> {
  return fetchApi<Folder[]>('/folders?all=true')
}

export async function createFolder(name: string, parentId?: string | null): Promise<Folder> {
  return fetchApi<Folder>('/folders', {
    method: 'POST',
    body: JSON.stringify({ name, parent_id: parentId || null }),
  })
}

export async function renameFolder(folderId: string, name: string): Promise<Folder> {
  return fetchApi<Folder>(`/folders/${folderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export async function deleteFolder(folderId: string): Promise<void> {
  const headers = await getAuthHeaders()
  const response = await fetch(`${API_URL}/folders/${folderId}`, {
    method: 'DELETE',
    headers,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Delete failed' }))
    throw new Error(error.detail || 'Delete failed')
  }
}

// Folder sharing
export async function toggleFolderSharing(folderId: string, isGlobal: boolean): Promise<Folder> {
  return fetchApi<Folder>(`/folders/${folderId}/share`, {
    method: 'PATCH',
    body: JSON.stringify({ is_global: isGlobal }),
  })
}

// Folder ancestors (breadcrumb path)
export interface FolderAncestor {
  id: string
  name: string
}

export async function getFolderAncestors(folderId: string): Promise<FolderAncestor[]> {
  return fetchApi<FolderAncestor[]>(`/folders/${folderId}/ancestors`)
}

// Skills API
export async function listSkills(): Promise<Skill[]> {
  return fetchApi<Skill[]>('/skills')
}

export async function createSkill(data: {
  name: string
  description: string
  instructions: string
  enabled?: boolean
}): Promise<Skill> {
  return fetchApi<Skill>('/skills', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function getSkill(skillId: string): Promise<Skill> {
  return fetchApi<Skill>(`/skills/${skillId}`)
}

export async function updateSkill(skillId: string, data: {
  name?: string
  description?: string
  instructions?: string
  enabled?: boolean
}): Promise<Skill> {
  return fetchApi<Skill>(`/skills/${skillId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteSkill(skillId: string): Promise<void> {
  const headers = await getAuthHeaders()
  const response = await fetch(`${API_URL}/skills/${skillId}`, {
    method: 'DELETE',
    headers,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Delete failed' }))
    throw new Error(error.detail || 'Delete failed')
  }
}

export async function toggleSkillSharing(skillId: string, isGlobal: boolean): Promise<Skill> {
  return fetchApi<Skill>(`/skills/${skillId}/share`, {
    method: 'PATCH',
    body: JSON.stringify({ is_global: isGlobal }),
  })
}

// Skill Import/Export API
export async function exportSkill(skillId: string): Promise<Blob> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new Error('Not authenticated')
  }

  const response = await fetch(`${API_URL}/skills/${skillId}/export`, {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Export failed' }))
    throw new Error(error.detail || 'Export failed')
  }

  return response.blob()
}

export async function importSkills(file: File): Promise<SkillImportResponse> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new Error('Not authenticated')
  }

  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(`${API_URL}/skills/import`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Import failed' }))
    throw new Error(error.detail || 'Import failed')
  }

  return response.json()
}

export async function importSkillFromUrl(source: string): Promise<SkillImportResponse> {
  return fetchApi<SkillImportResponse>('/skills/import-from-url', {
    method: 'POST',
    body: JSON.stringify({ source }),
  })
}

// Skill Files API
export async function listSkillFiles(skillId: string): Promise<SkillFile[]> {
  return fetchApi<SkillFile[]>(`/skills/${skillId}/files`)
}

export async function uploadSkillFile(skillId: string, file: File, folderPath?: string): Promise<SkillFile> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    throw new Error('Not authenticated')
  }

  const formData = new FormData()
  // If a folder path was supplied, prefix the upload's filename so the backend
  // stores it inside that virtual folder (filenames are path-segmented).
  const targetName = folderPath ? `${folderPath.replace(/\/+$/, '')}/${file.name}` : file.name
  formData.append('file', file, targetName)

  const response = await fetch(`${API_URL}/skills/${skillId}/files`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Upload failed' }))
    throw new Error(error.detail || 'Upload failed')
  }

  return response.json()
}

export async function deleteSkillFile(skillId: string, fileId: string): Promise<void> {
  const headers = await getAuthHeaders()
  const response = await fetch(`${API_URL}/skills/${skillId}/files/${fileId}`, {
    method: 'DELETE',
    headers,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Delete failed' }))
    throw new Error(error.detail || 'Delete failed')
  }
}

export async function renameSkillFile(skillId: string, fileId: string, filename: string): Promise<SkillFile> {
  return fetchApi<SkillFile>(`/skills/${skillId}/files/${fileId}`, {
    method: 'PATCH',
    body: JSON.stringify({ filename }),
  })
}

export async function createSkillFolder(skillId: string, path: string): Promise<SkillFile> {
  return fetchApi<SkillFile>(`/skills/${skillId}/folders`, {
    method: 'POST',
    body: JSON.stringify({ path }),
  })
}

export async function renameSkillFolder(skillId: string, oldPath: string, newPath: string): Promise<{ renamed: number }> {
  return fetchApi<{ renamed: number }>(`/skills/${skillId}/folders`, {
    method: 'PATCH',
    body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
  })
}

export async function deleteSkillFolder(skillId: string, path: string): Promise<{ deleted: number }> {
  return fetchApi<{ deleted: number }>(`/skills/${skillId}/folders?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
}

export async function getSkillFileContent(skillId: string, fileId: string): Promise<SkillFileContent> {
  return fetchApi<SkillFileContent>(`/skills/${skillId}/files/${fileId}/content`)
}

// Public Settings API
export const DEFAULT_CONTEXT_WINDOW = 128000

export async function getPublicSettings(): Promise<{ context_window: number }> {
  const response = await fetch(`${API_URL}/settings/public`)
  if (!response.ok) {
    return { context_window: DEFAULT_CONTEXT_WINDOW }
  }
  return response.json()
}

// Compaction API
export async function getCompactions(threadId: string): Promise<Compaction[]> {
  return fetchApi<Compaction[]>(`/threads/${threadId}/compactions`)
}

export async function triggerCompaction(threadId: string): Promise<Compaction | null> {
  return fetchApi<Compaction | null>(`/threads/${threadId}/compact`, { method: 'POST' })
}

// Workspace Files API
export async function getWorkspaceFiles(threadId: string): Promise<WorkspaceFile[]> {
  return fetchApi<WorkspaceFile[]>(`/threads/${threadId}/files`)
}

export async function getWorkspaceFileContent(threadId: string, filePath: string): Promise<string> {
  const headers = await getAuthHeaders()
  const response = await fetch(`${API_URL}/threads/${threadId}/files/${filePath}`, { headers })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Request failed' }))
    throw new Error(error.detail || 'Request failed')
  }
  return response.text()
}

export async function getWorkspaceFileDownloadUrl(threadId: string, filePath: string): Promise<string> {
  const data = await fetchApi<{ url: string }>(`/threads/${threadId}/files/${filePath}?download=true`)
  return data.url
}

// Sandbox API
export async function getSandboxFileDownloadUrl(fileId: string): Promise<{ download_url: string }> {
  return fetchApi<{ download_url: string }>(`/sandbox/files/${fileId}/download`)
}
