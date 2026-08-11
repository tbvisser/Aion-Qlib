import { useState } from 'react'
import { ChevronDown, ChevronRight, Archive } from 'lucide-react'

interface CompactionMarkerProps {
  evictedCount: number
  summary: string
  createdAt?: string
  modelUsed?: string
}

export function CompactionMarker({
  evictedCount,
  summary,
  createdAt,
  modelUsed,
}: CompactionMarkerProps) {
  const [expanded, setExpanded] = useState(false)

  const formattedDate = createdAt
    ? new Date(createdAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null

  return (
    <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 overflow-hidden animate-fade-in">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-4 py-3 hover:bg-sky-500/10 transition-colors text-left"
      >
        <div className="p-1 rounded-lg bg-sky-500/15">
          <Archive className="h-4 w-4 text-sky-400" />
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-sky-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-sky-400" />
        )}
        <span className="text-sm font-medium text-sky-300">
          Conversation compacted — {evictedCount} earlier turn
          {evictedCount === 1 ? '' : 's'} summarized
        </span>
        {formattedDate && (
          <span className="ml-auto text-xs text-sky-400/70">{formattedDate}</span>
        )}
      </button>
      {expanded && (
        <div className="px-4 pb-4 animate-fade-in">
          <div className="rounded-lg bg-background/50 p-4 max-h-72 overflow-y-auto border border-sky-500/20">
            <pre className="text-sm font-sans whitespace-pre-wrap text-muted-foreground leading-relaxed">
              {summary}
            </pre>
            {modelUsed && (
              <p className="mt-3 text-[11px] text-muted-foreground/70">
                Summarized by {modelUsed}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
