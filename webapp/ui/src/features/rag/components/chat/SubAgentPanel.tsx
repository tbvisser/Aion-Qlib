import { useState } from 'react'
import { AlertCircle, Check, ChevronDown, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SubAgentState, ExplorerToolCall } from '@/features/rag/types'
import { cn } from '@/lib/utils'
import { stripThinkTags } from '@/features/rag/lib/thinking'
import { getToolDisplayName, getToolIcon } from './toolRegistry'

interface SubAgentPanelProps {
  subAgent: SubAgentState
}

function getHeaderTitle(subAgent: SubAgentState): string {
  if (subAgent.mode === 'task') return 'Task'
  if (subAgent.mode === 'explore') return `Exploring: ${subAgent.researchQuery || 'knowledge base'}`
  return `Analyzing: ${subAgent.filename || 'document'}`
}

function getBrief(subAgent: SubAgentState): string {
  if (subAgent.brief) return subAgent.brief
  if (subAgent.mode === 'task') return subAgent.description || ''
  if (subAgent.mode === 'explore') return subAgent.researchQuery || ''
  return ''
}

function getResultText(subAgent: SubAgentState): string {
  return stripThinkTags(subAgent.result || subAgent.reasoning || '')
}

function getToolArgumentSummary(tc: ExplorerToolCall): string {
  const args = tc.arguments || {}
  const maybe = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    }
    return ''
  }

  if (tc.tool_name === 'grep') {
    const pattern = maybe('pattern')
    const path = maybe('path')
    return pattern && path ? `"${pattern}" in ${path}` : pattern
  }
  if (tc.tool_name === 'glob') return maybe('pattern')
  if (tc.tool_name === 'ls' || tc.tool_name === 'tree') return maybe('path') || 'root/'
  if (tc.tool_name === 'read' || tc.tool_name === 'read_file' || tc.tool_name === 'write_file' || tc.tool_name === 'edit_file') {
    return maybe('file_path', 'path', 'filename', 'document_id')
  }
  if (tc.tool_name === 'search_documents' || tc.tool_name === 'web_search') return maybe('query')
  if (tc.tool_name === 'get_document_sections' && Array.isArray(args.items)) {
    return `${args.items.length} item${args.items.length === 1 ? '' : 's'}`
  }
  return maybe('query', 'research_query', 'path', 'file_path', 'filename', 'document_id', 'pattern')
}

function getToolSummary(tc: ExplorerToolCall): string {
  const argSummary = getToolArgumentSummary(tc)
  const genericSummaries = new Set(['complete', 'completed', 'done', 'success'])
  const resultSummary = tc.result_summary?.trim()

  if (['read_file', 'write_file', 'edit_file'].includes(tc.tool_name) && argSummary) return argSummary
  if (resultSummary && !genericSummaries.has(resultSummary.toLowerCase())) return resultSummary
  return argSummary
}

function HeaderStatus({ status }: { status: SubAgentState['status'] }) {
  if (status === 'running') {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-primary">
        <span>Running</span>
        <span className="flex h-5 w-5 items-center justify-center">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        </span>
      </span>
    )
  }

  if (status === 'error') {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-red-400">
        <span>Error</span>
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500/15">
          <AlertCircle className="h-3 w-3" />
        </span>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
      <span>Complete</span>
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15">
        <Check className="h-3 w-3 text-emerald-400" />
      </span>
    </span>
  )
}

function MiniToolCallItem({ tc }: { tc: ExplorerToolCall }) {
  const ToolIcon = getToolIcon(tc.tool_name)
  const summary = getToolSummary(tc)

  return (
    <div className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5">
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted text-muted-foreground dark:bg-[#303030] dark:text-[#C8CBD0]">
        <ToolIcon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 truncate">
        <span className="text-[13px] font-semibold text-foreground">{getToolDisplayName(tc.tool_name)}</span>
        {summary && (
          <span className="ml-2 font-mono text-[11.5px] text-muted-foreground">{summary}</span>
        )}
      </span>
      {tc.status === 'completed' ? (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15">
          <Check className="h-3 w-3 text-emerald-400" />
        </span>
      ) : (
        <span className="flex h-5 w-5 items-center justify-center">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        </span>
      )}
    </div>
  )
}

export function SubAgentPanel({ subAgent }: SubAgentPanelProps) {
  const [expanded, setExpanded] = useState(true)

  const iconTool = subAgent.mode === 'task'
    ? 'task'
    : subAgent.mode === 'explore'
      ? 'explore_knowledge_base'
      : 'analyze_document'
  const Icon = getToolIcon(iconTool)
  const title = getHeaderTitle(subAgent)
  const brief = getBrief(subAgent)
  const result = getResultText(subAgent)
  const toolCalls = subAgent.mode === 'task'
    ? subAgent.taskToolCalls || []
    : subAgent.explorerToolCalls || []
  const hasContent = !!(brief || result || toolCalls.length > 0 || subAgent.status === 'error')

  return (
    <div className="overflow-hidden rounded-[14px] border border-border/60 bg-surface-2/80 animate-fade-in dark:border-[#2E2E2E] dark:bg-[#1D1D1D]">
      <button
        type="button"
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30 dark:hover:bg-[#262626]/70 ${!hasContent ? 'cursor-default' : ''}`}
        aria-expanded={expanded}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground dark:bg-[#303030] dark:text-[#C8CBD0]">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[14.5px] font-semibold text-foreground">
          {title}
        </span>
        <HeaderStatus status={subAgent.status} />
        {hasContent && (
          <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground/70 transition-transform ${expanded ? '' : '-rotate-90'}`} />
        )}
      </button>

      {expanded && hasContent && (
        <div className="space-y-3 px-4 pb-4 animate-fade-in">
          {brief && (
            <div className="rounded-lg border-l-2 border-border bg-background/60 px-3 py-2 text-[13.5px] leading-relaxed text-foreground dark:border-[#2E2E2E] dark:bg-[#161616]">
              {brief}
            </div>
          )}

          {toolCalls.length > 0 && (
            <div className="rounded-lg border border-border/40 bg-background/35 px-2 py-2 dark:border-[#212121] dark:bg-[#191919]">
              {toolCalls.map((tc, idx) => (
                <MiniToolCallItem key={`${tc.tool_name}-${idx}`} tc={tc} />
              ))}
            </div>
          )}

          {result && (
            <div
              className={cn(
                "prose prose-neutral dark:prose-invert prose-sm max-w-none text-[13.5px] leading-relaxed prose-p:my-2 prose-p:text-foreground/90 prose-strong:text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
                subAgent.mode === 'analyze' && 'max-h-[55vh] overflow-y-auto overscroll-contain pr-2 sm:max-h-96',
              )}
              tabIndex={subAgent.mode === 'analyze' ? 0 : undefined}
              aria-label={subAgent.mode === 'analyze' ? `${title} output` : undefined}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {result}
              </ReactMarkdown>
            </div>
          )}

          {subAgent.status === 'error' && !result && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              Sub-agent failed.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
