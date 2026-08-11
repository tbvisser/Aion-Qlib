import { Loader2, Check } from 'lucide-react'
import type { ToolCallInfo } from '@/types'
import { getToolDisplayName, getToolIcon } from './toolRegistry'

interface ToolCallIndicatorProps {
  toolCall: ToolCallInfo
}

export function ToolCallIndicator({ toolCall }: ToolCallIndicatorProps) {
  const Icon = getToolIcon(toolCall.tool_name)
  const label = getToolDisplayName(toolCall.tool_name)

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
      <Icon className="h-4 w-4" />
      <span>{label}</span>
      {toolCall.status === 'running' ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : toolCall.status === 'completed' ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : null}
    </div>
  )
}
