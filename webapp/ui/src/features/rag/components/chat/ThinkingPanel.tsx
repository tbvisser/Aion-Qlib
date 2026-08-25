import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'

interface ThinkingPanelProps {
  content: string
  isStreaming?: boolean
}

const DEFAULT_TITLE = 'Thought process'

function splitThinkingHeadline(content: string): { title: string; body: string } {
  const normalized = content.replace(/\r\n/g, '\n')
  const headlineMatch = normalized.match(
    /^\s*(?:(?:#{1,6}\s+(.+?)\s*#*)|\*\*(.+?)\*\*|__(.+?)__)\s*\n([\s\S]*)$/,
  )

  if (!headlineMatch) {
    return { title: DEFAULT_TITLE, body: content }
  }

  const title = (headlineMatch[1] || headlineMatch[2] || headlineMatch[3] || '').trim()
  if (!title) {
    return { title: DEFAULT_TITLE, body: content }
  }

  return {
    title,
    body: headlineMatch[4].replace(/^\s*\n/, ''),
  }
}

export function ThinkingPanel({ content, isStreaming = false }: ThinkingPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()

  if (!content) return null

  const { title, body } = splitThinkingHeadline(content)

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={() => setExpanded(!expanded)}
        className="group inline-flex max-w-full items-center gap-2 py-0.5 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 group-hover:text-foreground/80" />
        <span className="min-w-0 truncate text-sm text-foreground/75 group-hover:text-foreground">
          {title}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 group-hover:text-foreground/80" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 group-hover:text-foreground/80" />
        )}
        {isStreaming && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-pulse" />
            thinking…
          </span>
        )}
      </button>

      {/* Thinking body */}
      {expanded && (
        <div
          id={bodyId}
          data-testid="thinking-body"
          className="ml-7 mt-2 border-l border-border pl-4 animate-fade-in"
        >
          <div className="whitespace-pre-wrap text-sm italic leading-relaxed text-muted-foreground">
            {body}
          </div>
        </div>
      )}
    </div>
  )
}
