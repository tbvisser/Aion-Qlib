import { useState } from 'react'
import { ChevronDown, ChevronRight, FileCheck, Loader2, Check, AlertCircle, User, Clock } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { HarnessPhaseState, HarnessToolCall, HarnessSubAgent } from '@/types'
import { stripThinkTags } from '@/lib/thinking'
import { getToolDisplayName, getToolIcon } from './toolRegistry'

interface HarnessPhasePanelProps {
  phase: HarnessPhaseState
}

function getToolDescription(tc: HarnessToolCall): string {
  try {
    const args = JSON.parse(tc.arguments)
    // Show the query/search term for search tools
    if (args.query) return args.query
    if (args.pattern) return args.pattern
    if (args.file_path) return args.file_path
    if (args.path) return args.path
  } catch {
    // ignore
  }
  return ''
}

function ToolCallItem({ tc }: { tc: HarnessToolCall }) {
  const displayName = getToolDisplayName(tc.toolName)
  const ToolIcon = getToolIcon(tc.toolName)
  const description = getToolDescription(tc)

  return (
    <div className="flex items-center gap-2 text-xs py-1">
      {tc.status === 'completed' ? (
        <Check className="h-3 w-3 text-emerald-400 shrink-0" />
      ) : (
        <Loader2 className="h-3 w-3 animate-spin text-blue-400 shrink-0" />
      )}
      <ToolIcon className="h-3 w-3 text-muted-foreground/60 shrink-0" />
      <div className="min-w-0 overflow-hidden">
        <span className="text-muted-foreground font-medium">{displayName}</span>
        {description && (
          <span className="text-muted-foreground/60 ml-1.5 block truncate">{description}</span>
        )}
      </div>
    </div>
  )
}

function SubAgentItem({ agent }: { agent: HarnessSubAgent }) {
  const hasToolCalls = agent.toolCalls.length > 0
  const hasContent = hasToolCalls || (agent.status === 'completed' && !hasToolCalls)
  const [expanded, setExpanded] = useState(agent.status === 'running')
  const completedTools = agent.toolCalls.filter(tc => tc.status === 'completed').length

  return (
    <div className="border-l-2 border-blue-500/20 pl-3 py-1">
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs w-full text-left"
      >
        {agent.status === 'completed' ? (
          <Check className="h-3 w-3 text-emerald-400 shrink-0" />
        ) : agent.status === 'error' ? (
          <AlertCircle className="h-3 w-3 text-red-400 shrink-0" />
        ) : (
          <Loader2 className="h-3 w-3 animate-spin text-blue-400 shrink-0" />
        )}
        <span className="text-blue-300 font-medium truncate">Clause {agent.clauseRef}</span>
        {!expanded && hasToolCalls && (
          <span className="text-blue-400/50 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10">
            {completedTools}/{agent.toolCalls.length}
          </span>
        )}
        {!expanded && !hasToolCalls && agent.status === 'completed' && (
          <span className="text-blue-400/50 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10">
            context only
          </span>
        )}
        {hasContent && (
          expanded
            ? <ChevronDown className="h-3 w-3 text-blue-400/50 shrink-0 ml-auto" />
            : <ChevronRight className="h-3 w-3 text-blue-400/50 shrink-0 ml-auto" />
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-5 space-y-0.5">
          {hasToolCalls ? (
            agent.toolCalls.map((tc, idx) => (
              <ToolCallItem key={idx} tc={tc} />
            ))
          ) : agent.status === 'completed' ? (
            <div className="text-xs text-muted-foreground/60 py-0.5">
              Assessed using workspace context — no additional lookups needed
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function HarnessPhasePanel({ phase }: HarnessPhasePanelProps) {
  const [expanded, setExpanded] = useState(phase.status === 'running' || phase.status === 'error')
  const resultMarkdown = stripThinkTags(phase.resultMarkdown || '')

  const statusIcon = {
    running: <Loader2 className="h-4 w-4 animate-spin text-blue-400" />,
    completed: (
      <div className="w-5 h-5 flex items-center justify-center rounded-full bg-emerald-500/15">
        <Check className="h-3 w-3 text-emerald-400" />
      </div>
    ),
    error: (
      <div className="w-5 h-5 flex items-center justify-center rounded-full bg-red-500/15">
        <AlertCircle className="h-3 w-3 text-red-400" />
      </div>
    ),
  }[phase.status]

  const hasToolCalls = phase.toolCalls.length > 0
  const hasSubAgents = (phase.subAgents?.length || 0) > 0
  const isAgentPhase = phase.agentRound !== undefined
  const hasContent = !!(resultMarkdown || phase.error || hasToolCalls || isAgentPhase || hasSubAgents || phase.isHumanInput)

  // Show step count badge when collapsed
  const completedTools = phase.toolCalls.filter(tc => tc.status === 'completed').length
  const totalTools = phase.toolCalls.length
  const completedAgents = phase.subAgents?.filter(sa => sa.status === 'completed').length || 0
  const totalAgents = phase.subAgents?.length || 0

  return (
    <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 overflow-hidden animate-fade-in">
      {/* Header */}
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2.5 px-4 py-3 hover:bg-blue-500/10 transition-colors ${!hasContent ? 'cursor-default' : ''}`}
      >
        <div className="p-1 rounded-lg bg-blue-500/15">
          {phase.isHumanInput ? (
            <User className="h-4 w-4 text-blue-400" />
          ) : (
            <FileCheck className="h-4 w-4 text-blue-400" />
          )}
        </div>
        {hasContent ? (
          expanded ? (
            <ChevronDown className="h-4 w-4 text-blue-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-blue-400" />
          )
        ) : (
          <div className="w-4" />
        )}
        <span className="text-sm font-medium flex-1 text-left text-blue-300 truncate">
          Phase {phase.phaseIndex + 1}: {phase.phaseName}
        </span>
        {/* Collapsed badges */}
        {!expanded && hasSubAgents && (
          <span className="text-xs text-blue-400/70 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            {completedAgents === totalAgents ? `${totalAgents} clauses` : `${completedAgents}/${totalAgents} clauses`}
          </span>
        )}
        {!expanded && !hasSubAgents && hasToolCalls && (
          <span className="text-xs text-blue-400/70 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            {completedTools === totalTools ? `${totalTools} steps` : `${completedTools}/${totalTools} steps`}
          </span>
        )}
        {!expanded && phase.isHumanInput && phase.status === 'running' && (
          <span className="text-xs text-amber-400/70 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20">
            Waiting for input
          </span>
        )}
        {!expanded && isAgentPhase && phase.status === 'running' && !hasToolCalls && !hasSubAgents && !phase.isHumanInput && (
          <span className="text-xs text-blue-400/70 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            Analyzing...
          </span>
        )}
        {statusIcon}
      </button>

      {/* Body */}
      {expanded && hasContent && (
        <div className="px-4 pb-4 animate-fade-in space-y-3">
          {/* Human input waiting state */}
          {phase.isHumanInput && phase.status === 'running' && (
            <div className="flex items-center gap-2 text-xs text-amber-400/80 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              <span>Waiting for your input — type your response in the chat below</span>
            </div>
          )}

          {/* Human input completed state */}
          {phase.isHumanInput && phase.status === 'completed' && (
            <div className="flex items-center gap-2 text-xs text-emerald-400/80 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
              <User className="h-3.5 w-3.5 shrink-0" />
              <span>User input received</span>
            </div>
          )}

          {/* Batch progress indicator */}
          {phase.batchProgress && phase.status === 'running' && (
            <div className="flex items-center gap-2 text-xs text-blue-400/70">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>
                Batch {phase.batchProgress.current + 1}/{phase.batchProgress.total} — {phase.batchProgress.processed + completedAgents}/{totalAgents || '?'} items analyzed
              </span>
            </div>
          )}

          {/* Agent round indicator (for non-batch agent phases) */}
          {isAgentPhase && phase.status === 'running' && !hasSubAgents && (
            <div className="flex items-center gap-2 text-xs text-blue-400/70">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Agent round {phase.agentRound} — researching and analyzing</span>
            </div>
          )}

          {/* Sub-agents (batch phases) */}
          {hasSubAgents && (
            <div className="rounded-lg bg-background/50 px-3 py-2 border border-blue-500/20 space-y-1">
              {phase.subAgents!.map((agent) => (
                <SubAgentItem key={agent.subAgentId} agent={agent} />
              ))}
            </div>
          )}

          {/* Tool calls (non-batch phases) */}
          {!hasSubAgents && hasToolCalls && (
            <div className="rounded-lg bg-background/50 px-3 py-2 border border-blue-500/20">
              <div className="space-y-0.5">
                {phase.toolCalls.map((tc, idx) => (
                  <ToolCallItem key={tc.toolCallId || idx} tc={tc} />
                ))}
              </div>
            </div>
          )}

          {/* Error */}
          {phase.error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-300">
              {phase.error}
            </div>
          )}

          {/* Result markdown */}
          {resultMarkdown && (
            <div className="rounded-lg bg-background/50 p-4 border border-blue-500/20 prose prose-invert prose-sm max-w-none max-h-96 overflow-y-auto
              prose-headings:text-blue-200 prose-strong:text-blue-100 prose-li:text-muted-foreground prose-p:text-muted-foreground
              [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {resultMarkdown}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
