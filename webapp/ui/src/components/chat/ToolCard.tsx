/**
 * What the assistant actually did — visible, not hidden behind the prose.
 *
 * Lifted out of ChatPage so the builder's dock shows tool activity the same way.
 * Deliberately generic over tool name: the one tool that gets a bespoke
 * rendering is `propose_strategy`, and that is handled by the caller rather than
 * by a special case in here.
 */
import { useState } from 'react'
import { Wrench } from 'lucide-react'

import type { ToolEvent } from '@/lib/chat'
import { cn } from '@/lib/utils'

export function ToolCard({ tool }: { tool: ToolEvent }) {
  const [open, setOpen] = useState(false)
  const pending = tool.result === undefined

  return (
    <div className="overflow-hidden rounded-lg border border-border/50 bg-surface-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-foreground/[0.04]"
      >
        <Wrench className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground',
                              pending && 'animate-subtle-pulse')} />
        <span className="font-mono text-xs">{tool.name}</span>
        <span className="ml-auto font-mono text-micro uppercase text-muted-foreground">
          {pending ? 'running' : 'done'}
        </span>
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto border-t border-border/50 p-3 font-mono text-micro leading-relaxed">
          {JSON.stringify({ arguments: tool.arguments, result: tool.result }, null, 2)}
        </pre>
      )}
    </div>
  )
}
