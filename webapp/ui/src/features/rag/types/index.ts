export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ToolSearchResult {
  query: string
  matches: string[]
  tools_loaded: number
}

export interface Thread {
  id: string
  user_id: string
  title: string
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  thread_id: string
  user_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
  tool_calls?: ToolCallInfo[] | null
  attachments?: MessageAttachment[] | null
  harness_mode?: string | null
  harness_phases_before?: number[] | null
  sequence_number?: number | null
  citations?: AnswerCitation[] | null
  verification_mode?: CitationVerificationMode | null
}

export interface MessageAttachment {
  file_path: string
  content_type: string
  size_bytes: number
  source?: string
}

export type CitationVerificationMode = 'unverified' | 'semantic-text'

export type CitationSupportStatus =
  | 'verified'
  | 'partially_supported'
  | 'not_verified'
  | 'contradicted'
  | 'verification_failed'

export interface CitationSource {
  source_id: string
  source_type: 'document' | 'workspace_file' | 'web'
  title: string
  uri?: string
  document_id?: string
  thread_id?: string
  file_path?: string
  content_type?: string
  content_hash?: string
}

export interface CitationTarget {
  kind: 'text_quote' | 'text_position' | 'chunk' | 'selector' | 'page'
  exact?: string
  prefix?: string
  suffix?: string
  start_char?: number
  end_char?: number
  chunk_id?: string
  selector?: string
  page?: number
  bboxes?: PdfCitationHighlight[]
}

export interface PdfCitationHighlight {
  page: number
  l: number
  t: number
  r: number
  b: number
  coord_origin?: 'BOTTOMLEFT' | 'TOPLEFT' | string
  item_id?: string
}

export interface AnswerCitation {
  citation_id: string
  answer_id: string
  display_ref: string
  display_number: number
  source: CitationSource
  target: CitationTarget
  quote?: string
  status: CitationSupportStatus
  support_score?: number
  claim_id?: string
  problem?: string | null
}

export interface Compaction {
  id: string
  thread_id: string
  user_id: string
  summary_text: string
  covers_from_sequence: number
  covers_to_sequence: number
  evicted_message_count: number
  summary_tokens: number
  model_used: string
  previous_compaction_id: string | null
  created_at: string
}

export interface CompactionStatusEvent {
  action: 'tool_prune' | 'window' | 'summarize' | 'failed'
  compaction_id?: string | null
}

export interface MetadataFieldDefinition {
  name: string
  type: 'string' | 'list' | 'enum' | 'number' | 'boolean'
  required: boolean
  description: string
  enum_values?: string[]
}

export interface Document {
  id: string
  user_id: string
  folder_id: string | null
  filename: string
  file_type: string
  file_size: number
  storage_path: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  error_message: string | null
  ingestion_stage: string | null
  ingestion_progress: number | null
  ingestion_message: string | null
  chunk_count: number
  content_hash: string | null
  hierarchical_index: string | null
  metadata: Record<string, any> | null
  action?: 'created' | 'skipped' | 'updated'
  created_at: string
  updated_at: string
}

export interface ToolCallInfo {
  tool_name: string
  arguments: string
  status: 'running' | 'completed' | 'error'
  result_summary?: string
  result?: string
  sub_agent_state?: SubAgentState
  code_execution_state?: CodeExecutionState
}

export interface ExplorerToolCall {
  tool_name: string
  arguments: Record<string, any>
  round: number
  result_summary?: string
  status: 'running' | 'completed'
}

export interface SubAgentState {
  active: boolean
  mode: 'analyze' | 'explore' | 'task'
  // analyze_document fields
  documentId?: string
  filename?: string
  // explore_knowledge_base fields
  researchQuery?: string
  explorerToolCalls?: ExplorerToolCall[]
  // task sub-agent fields
  description?: string
  subAgentId?: string
  taskToolCalls?: ExplorerToolCall[]
  // shared fields
  reasoning: string
  result?: string
  brief?: string
  status: 'running' | 'completed' | 'error'
}

export interface Folder {
  id: string
  user_id: string | null  // null for global folders
  parent_id: string | null // null for root-level folders
  name: string
  shared_by: string | null // original owner ID when shared globally
  created_at: string
  updated_at: string
}

export interface CodeExecutionState {
  active: boolean
  executionId: string
  language: string
  codePreview: string
  summary?: string
  stdout: string
  stderr: string
  status: 'running' | 'completed' | 'error'
  exitCode?: number
  executionTimeMs?: number
  files: CodeExecutionFile[]
  error?: string
}

export interface CodeExecutionFile {
  filename: string
  download_url: string
  file_size: number
  content_type: string
  error?: string
}

export interface Skill {
  id: string
  user_id: string | null
  name: string
  description: string
  instructions: string
  enabled: boolean
  shared_by: string | null // original owner ID when shared globally
  license: string | null
  compatibility: string | null
  metadata: Record<string, string> | null
  source_url?: string | null // origin URL when imported from a remote registry
  created_at: string
  updated_at: string
}

export interface SkillImportResult {
  name: string
  success: boolean
  skill_id: string | null
  error: string | null
}

export interface SkillImportResponse {
  imported: number
  failed: number
  results: SkillImportResult[]
}

export interface SkillFile {
  id: string
  skill_id: string
  filename: string
  file_size: number
  mime_type: string
  created_at: string
}

export interface SkillFileContent {
  filename: string
  mime_type: string
  download_url: string
  content: string | null
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  position: number
}

export interface WorkspaceFile {
  id: string
  thread_id: string
  file_path: string
  size_bytes: number
  content_type: string
  source: 'agent' | 'sandbox' | 'upload'
  storage_path: string | null
  created_at: string
  updated_at: string
}

export type AgentStatus = 'working' | 'waiting_for_user' | 'complete' | 'error'

export interface HarnessRunPhaseToolCall {
  tool_name: string
  arguments: string
  result?: string | null
}

export interface HarnessRunPhase {
  index: number
  name: string
  description: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  result_markdown?: string | null
  tool_calls?: HarnessRunPhaseToolCall[]
  phase_type?: string | null
}

export interface HarnessRun {
  id: string
  thread_id: string
  harness_type: string
  status: string
  current_phase: number
  phases: HarnessRunPhase[]
}

export interface HarnessToolCall {
  toolCallId?: string
  toolName: string
  arguments: string
  result?: string
  status: 'running' | 'completed'
}

export interface HarnessSubAgent {
  subAgentId: string
  clauseRef: string
  description: string
  status: 'running' | 'completed' | 'error'
  toolCalls: HarnessToolCall[]
  result?: string
}

export interface HarnessBatchProgress {
  current: number
  total: number
  processed: number
}

export interface HarnessPhaseState {
  phaseIndex: number
  phaseName: string
  phaseDescription: string
  status: 'running' | 'completed' | 'error'
  resultMarkdown: string
  toolCalls: HarnessToolCall[]
  error?: string
  agentRound?: number
  agentMaxRounds?: number
  subAgents?: HarnessSubAgent[]
  batchProgress?: HarnessBatchProgress
  isHumanInput?: boolean
}
