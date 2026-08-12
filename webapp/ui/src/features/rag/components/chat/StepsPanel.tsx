import { useState, useRef, useEffect } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Code, Loader2, Check, Circle } from 'lucide-react'
import type { ToolCallInfo } from '@/features/rag/types'
import { getToolDisplayName, getToolIcon, toolGroupIcon } from './toolRegistry'

interface StepsPanelProps {
  toolCalls: ToolCallInfo[]
}

/**
 * Extract a JSON string value from partial JSON, handling escape sequences.
 * Starts reading from the opening quote at position `start`.
 */
function extractJsonStringValue(args: string, start: number): string {
  let i = start
  // Skip to opening quote
  while (i < args.length && args[i] !== '"') i++
  if (i >= args.length) return ''
  i++ // skip opening quote

  let result = ''
  while (i < args.length) {
    if (args[i] === '\\' && i + 1 < args.length) {
      const next = args[i + 1]
      if (next === 'n') { result += '\n'; i += 2 }
      else if (next === 't') { result += '\t'; i += 2 }
      else if (next === '"') { result += '"'; i += 2 }
      else if (next === '\\') { result += '\\'; i += 2 }
      else if (next === '/') { result += '/'; i += 2 }
      else { result += args[i]; i++ }
    } else if (args[i] === '"') {
      break // closing quote — value complete
    } else {
      result += args[i]
      i++
    }
  }
  return result
}

/**
 * Extract streaming info from partial JSON tool-call arguments.
 *
 * Returns the code (if the "code" key has appeared), plus any library
 * names found so we can show progress even before the code field starts.
 */
function extractStreamingInfo(args: string): { code: string | null; libraries: string[] } {
  // Try complete JSON first
  try {
    const parsed = JSON.parse(args)
    return {
      code: parsed.code || null,
      libraries: Array.isArray(parsed.libraries) ? parsed.libraries : [],
    }
  } catch {
    // Partial JSON — extract fields as they appear
    const libraries: string[] = []

    // Extract library names from "libraries": ["lib1", "lib2", ...]
    const libStart = args.indexOf('"libraries"')
    if (libStart !== -1) {
      const bracketStart = args.indexOf('[', libStart)
      if (bracketStart !== -1) {
        const libSection = args.slice(bracketStart)
        const matches = libSection.matchAll(/"([^"]+)"/g)
        for (const m of matches) {
          libraries.push(m[1])
        }
      }
    }

    // Extract code if key has appeared
    const codeStart = args.indexOf('"code"')
    if (codeStart === -1) return { code: null, libraries }

    const afterKey = args.indexOf(':', codeStart + 6)
    if (afterKey === -1) return { code: null, libraries }

    const code = extractJsonStringValue(args, afterKey + 1)
    return { code: code || null, libraries }
  }
}

function getQueryFromArgs(toolName: string, args: string): string {
  if (!args) {
    if (toolName === 'execute_code') return 'Generating code...'
    return 'Preparing...'
  }
  try {
    const parsed = JSON.parse(args)
    if (toolName === 'calculator') {
      return parsed.expression || 'Calculating'
    }
    if (toolName === 'ls' || toolName === 'tree') {
      return parsed.path || 'root/'
    }
    if (toolName === 'glob') {
      return parsed.pattern ? `"${parsed.pattern}"` : 'Finding files'
    }
    if (toolName === 'grep') {
      const pattern = parsed.pattern ? `"${parsed.pattern}"` : 'Search pattern'
      return parsed.path ? `${pattern} in ${parsed.path}` : pattern
    }
    if (toolName === 'list_files') {
      return 'Workspace files'
    }
    if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file' || toolName === 'append_file') {
      return parsed.file_path || parsed.path || 'Workspace file'
    }
    if (toolName === 'read') {
      return parsed.document_id || parsed.filename || 'Document'
    }
    if (toolName === 'search_documents' || toolName === 'web_search') {
      return parsed.query || args
    }
    if (toolName === 'query_sales_database') {
      // Show a truncated SQL query
      const sql = parsed.sql || parsed.query || ''
      return sql.length > 60 ? sql.substring(0, 57) + '...' : sql
    }
    if (toolName === 'analyze_document') {
      return parsed.query || 'Analyzing document'
    }
    if (toolName === 'get_document_structure') {
      return parsed.document_id || 'Document outline'
    }
    if (toolName === 'get_document_sections') {
      return parsed.document_id ? `${parsed.document_id} sections` : 'Document sections'
    }
    if (toolName === 'explore_knowledge_base') {
      return parsed.research_query || parsed.query || 'Knowledge base'
    }
    if (toolName === 'get_team_members') {
      return parsed.department || 'Team'
    }
    if (toolName === 'get_budget_by_level') {
      return parsed.level || 'Budget level'
    }
    if (toolName === 'get_expenses') {
      return [parsed.user_id, parsed.quarter].filter(Boolean).join(' - ') || 'Expenses'
    }
    if (toolName === 'load_skill') {
      return parsed.skill_id || parsed.name || 'Skill'
    }
    if (toolName === 'read_skill_file' || toolName === 'upload_skill_file') {
      return parsed.filename || parsed.file_name || 'Skill file'
    }
    if (toolName === 'save_skill') {
      return parsed.name || parsed.skill_name || 'Skill'
    }
    if (toolName === 'write_todos' || toolName === 'read_todos') {
      return 'Plan'
    }
    if (toolName === 'task') {
      return parsed.description || 'Delegating task'
    }
    if (toolName === 'tool_search') {
      return parsed.query || 'Tool catalog'
    }
    if (toolName === 'execute_code') {
      const preview = (parsed.code || '').substring(0, 50)
      return `[Python] ${preview}${(parsed.code || '').length > 50 ? '...' : ''}`
    }
    const usefulValue = parsed.query || parsed.path || parsed.file_path || parsed.pattern || parsed.name
    return usefulValue || getToolDisplayName(toolName)
  } catch {
    // Partial JSON — extract whatever info is available
    if (toolName === 'execute_code') {
      const info = extractStreamingInfo(args)
      if (info.code) {
        const preview = info.code.substring(0, 50)
        return `[Python] ${preview}${info.code.length > 50 ? '...' : ''}`
      }
      if (info.libraries.length > 0) {
        return `[Python] Installing ${info.libraries.join(', ')}...`
      }
      return `[Python] Preparing...`
    }
    return args
  }
}

function parseToolArguments(args: string): { request: Record<string, unknown> | null; raw: string; isJson: boolean } {
  if (!args) return { request: {}, raw: '', isJson: true }

  try {
    const parsed = JSON.parse(args) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { request: parsed as Record<string, unknown>, raw: args, isJson: true }
    }
    return { request: { value: parsed }, raw: args, isJson: true }
  } catch {
    return { request: null, raw: args, isJson: false }
  }
}

function formatRawPayload(value: unknown): string {
  if (typeof value === 'string') {
    if (!value) return ''
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }

  const formatted = JSON.stringify(value, null, 2)
  return formatted ?? ''
}

function formatResponse(result?: string): string {
  if (!result) return 'Waiting for response...'

  try {
    const parsed = JSON.parse(result) as unknown
    if (typeof parsed === 'string') return parsed
    return JSON.stringify(parsed, null, 2) ?? result
  } catch {
    return result
  }
}

function FormattedValue({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    return <span className="text-primary">"{value}"</span>
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="text-amber-400">{String(value)}</span>
  }

  if (value === null) {
    return <span className="text-muted-foreground/70">null</span>
  }

  if (Array.isArray(value) || typeof value === 'object') {
    return (
      <pre className="inline whitespace-pre-wrap break-words text-foreground/85">
        {formatRawPayload(value)}
      </pre>
    )
  }

  return <span className="text-foreground/85">{String(value)}</span>
}

function RequestView({ args }: { args: string }) {
  const parsed = parseToolArguments(args)

  if (!parsed.isJson && parsed.raw) {
    return (
      <pre className="whitespace-pre-wrap break-words text-foreground/80">
        {parsed.raw}
      </pre>
    )
  }

  const request = parsed.request ?? {}
  const entries = Object.entries(request)

  if (entries.length === 0) {
    return <div className="text-muted-foreground/70">No parameters</div>
  }

  return (
    <div className="space-y-1.5">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start gap-2 leading-relaxed">
          <span className="min-w-0 shrink-0 text-muted-foreground/70">{key}:</span>
          <span className="min-w-0 break-words text-foreground/85">
            <FormattedValue value={value} />
          </span>
        </div>
      ))}
    </div>
  )
}

function ResponseView({ result, status }: { result?: string; status: ToolCallInfo['status'] }) {
  const empty = !result && status !== 'completed'

  return (
    <pre className={`whitespace-pre-wrap break-words ${empty ? 'text-muted-foreground/70' : 'text-foreground/90'}`}>
      {formatResponse(result)}
    </pre>
  )
}

function RawView({ value }: { value: unknown }) {
  return (
    <pre className="whitespace-pre-wrap break-words text-foreground/85">
      {formatRawPayload(value)}
    </pre>
  )
}

function ToolStatus({ toolCall }: { toolCall: ToolCallInfo }) {
  if (toolCall.status === 'running') {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-primary">
        <span>Running</span>
        <span className="flex h-5 w-5 items-center justify-center">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </span>
      </span>
    )
  }

  if (toolCall.status === 'error') {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-red-400">
        <span>{toolCall.result_summary || 'Error'}</span>
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500/15">
          <AlertCircle className="h-3 w-3" />
        </span>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
      <span>{toolCall.result_summary || 'Complete'}</span>
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15">
        <Check className="h-3 w-3 text-emerald-400" />
      </span>
    </span>
  )
}

/**
 * Auto-scrolling code preview that shows content immediately as it streams.
 *
 * Three phases:
 * 1. Pre-code: shows libraries being prepared (if any)
 * 2. Code streaming: shows code appearing token-by-token
 * 3. Complete: shows full code
 */
function CodeStreamPreview({ args, isComplete }: { args: string; isComplete?: boolean }) {
  const { code, libraries } = extractStreamingInfo(args)
  const preRef = useRef<HTMLPreElement>(null)

  // Auto-scroll to bottom as content grows (only while streaming)
  useEffect(() => {
    if (preRef.current && !isComplete) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [code, libraries, isComplete])

  // Phase 1: No code yet — show library install or preparing status
  if (!code) {
    if (libraries.length === 0 && args.length < 3) return null // still waiting for first chars

    return (
      <div className="mt-2 rounded-lg border border-border/50 bg-surface-1 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b border-border/40">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">python</span>
          <span className="text-[10px] text-muted-foreground">preparing</span>
        </div>
        <pre className="p-3 text-xs font-mono text-muted-foreground leading-relaxed">
          {libraries.length > 0
            ? `$ pip install ${libraries.join(' ')}\n`
            : ''
          }
          {!isComplete && <span className="animate-pulse text-primary">|</span>}
        </pre>
      </div>
    )
  }

  // Phase 2 & 3: Code is streaming or complete
  const lines = code.split('\n')
  const lineCount = lines.length

  return (
    <div className="mt-2 rounded-lg border border-border/50 bg-surface-1 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b border-border/40">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">python</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">{lineCount} line{lineCount !== 1 ? 's' : ''}</span>
      </div>
      <pre
        ref={preRef}
        className="p-3 text-xs font-mono text-foreground/85 overflow-auto max-h-48 leading-relaxed"
      >{code}{!isComplete && <span className="animate-pulse text-primary">|</span>}</pre>
    </div>
  )
}

export function StepsPanel({ toolCalls }: StepsPanelProps) {
  const [expanded, setExpanded] = useState(true)
  const [expandedResults, setExpandedResults] = useState<Set<number>>(new Set())
  const [rawResults, setRawResults] = useState<Set<number>>(new Set())

  const toggleResult = (idx: number) => {
    setExpandedResults(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
    setRawResults(prev => {
      const next = new Set(prev)
      next.delete(idx)
      return next
    })
  }

  const toggleRaw = (idx: number) => {
    setRawResults(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  if (toolCalls.length === 0) return null

  const GroupIcon = toolGroupIcon
  const groupLabel = `Ran ${toolCalls.length} tool${toolCalls.length === 1 ? '' : 's'}`

  return (
    <div className="overflow-hidden rounded-[14px] border border-border/60 bg-surface-2/80 animate-fade-in dark:border-[#2E2E2E] dark:bg-[#1D1D1D]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm transition-colors hover:bg-muted/30 dark:hover:bg-[#262626]/70"
        aria-expanded={expanded}
      >
        <GroupIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-semibold text-foreground">{groupLabel}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {expanded ? 'Hide steps' : 'Show steps'}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        </span>
      </button>

      {expanded && (
        <div className="px-2 pb-2">
          {toolCalls.map((tc, idx) => {
            const Icon = getToolIcon(tc.tool_name)
            const label = getToolDisplayName(tc.tool_name)
            const query = getQueryFromArgs(tc.tool_name, tc.arguments)
            const isCodeStreaming = tc.tool_name === 'execute_code' && tc.status === 'running' && tc.arguments.length > 0
            const showCodePreview = tc.tool_name === 'execute_code' && tc.arguments.length > 0
            const isOpen = expandedResults.has(idx)
            const isRaw = rawResults.has(idx)
            const rawRequest = parseToolArguments(tc.arguments)
            const rowCanExpand = !!(tc.arguments || tc.result || showCodePreview || tc.status !== 'completed')

            return (
              <div
                key={`${tc.tool_name}-${idx}`}
                className={`rounded-[10px] text-sm animate-fade-in ${isOpen ? 'bg-muted/60 dark:bg-[#262626]' : 'bg-transparent'}`}
                style={{ animationDelay: `${idx * 100}ms` }}
              >
                <button
                  type="button"
                  onClick={() => rowCanExpand && toggleResult(idx)}
                  className={`grid w-full grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-2 rounded-[10px] px-2.5 py-2.5 text-left transition-colors ${rowCanExpand ? 'hover:bg-muted/70 dark:hover:bg-[#262626]' : 'cursor-default'}`}
                  aria-expanded={isOpen}
                >
                  <div className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-muted text-muted-foreground dark:bg-[#303030] dark:text-[#C8CBD0]">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[14.5px] font-semibold leading-tight text-foreground">
                      {label}
                    </div>
                    <div className={`mt-0.5 text-[12.75px] leading-tight text-muted-foreground ${isCodeStreaming ? '' : 'truncate'}`}>
                      {query}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <ToolStatus toolCall={tc} />
                    {rowCanExpand ? (
                      <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground/70 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    ) : (
                      <Circle className="h-3 w-3 text-muted-foreground/50" />
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="px-3 pb-3 animate-fade-in">
                    <div className="overflow-hidden rounded-[10px] border border-border/50 bg-background/70 font-mono text-[12.5px] leading-relaxed dark:border-[#212121] dark:bg-[#161616]">
                      <div className="grid grid-cols-[42px_minmax(0,1fr)] border-b border-border/50 dark:border-[#212121]">
                        <div className="px-3 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                          Req
                        </div>
                        <div className="max-h-[220px] overflow-auto px-3 py-3">
                          {isRaw ? <RawView value={rawRequest.isJson ? rawRequest.request : rawRequest.raw} /> : <RequestView args={tc.arguments} />}
                        </div>
                      </div>
                      <div className="grid grid-cols-[42px_minmax(0,1fr)]">
                        <div className="px-3 py-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                          Res
                        </div>
                        <div className="max-h-[220px] overflow-auto px-3 py-3">
                          {isRaw ? <RawView value={tc.result ?? ''} /> : <ResponseView result={tc.result} status={tc.status} />}
                        </div>
                      </div>
                    </div>
                    {showCodePreview && (
                      <CodeStreamPreview args={tc.arguments} isComplete={tc.status === 'completed'} />
                    )}
                    <button
                      type="button"
                      onClick={() => toggleRaw(idx)}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-muted-foreground/70 hover:text-foreground dark:border-[#2E2E2E]"
                    >
                      <Code className="h-3 w-3" />
                      {isRaw ? 'Formatted' : 'View raw'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
