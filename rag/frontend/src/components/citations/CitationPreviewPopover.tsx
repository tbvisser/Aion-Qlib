import { ExternalLink, FileText, FolderOpen, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { effectiveStatus, safeWebUrl } from './citationUtils'
import type { AnswerCitation, CitationVerificationMode } from '@/types'

interface CitationPreviewPopoverProps {
  citation: AnswerCitation
  verificationMode?: CitationVerificationMode | null
  onView: () => void
}

function SourceIcon({ kind }: { kind: AnswerCitation['source']['source_type'] }) {
  if (kind === 'document') return <FileText className="h-3.5 w-3.5" />
  if (kind === 'workspace_file') return <FolderOpen className="h-3.5 w-3.5" />
  return <Globe className="h-3.5 w-3.5" />
}

function sourceLabel(kind: AnswerCitation['source']['source_type']) {
  if (kind === 'document') return 'Document'
  if (kind === 'workspace_file') return 'Workspace file'
  return 'Web'
}

export function CitationPreviewPopover({
  citation,
  verificationMode,
  onView,
}: CitationPreviewPopoverProps) {
  const status = effectiveStatus(citation.status, verificationMode)
  const safeUri = safeWebUrl(citation.source.uri)

  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-2 px-4 py-3 border-b border-border/60">
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          <SourceIcon kind={citation.source.source_type} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>{sourceLabel(citation.source.source_type)}</span>
            <span aria-hidden>·</span>
            <span>#{citation.display_number}</span>
          </div>
          <div className="text-sm font-medium truncate" title={citation.source.title}>
            {citation.source.title}
          </div>
        </div>
      </div>

      <div className="px-4 py-3 space-y-2">
        {citation.quote && (
          <blockquote className="text-xs leading-snug text-foreground bg-muted/40 border-l-2 border-border px-2 py-1.5 rounded-sm max-h-32 overflow-y-auto">
            {citation.quote}
          </blockquote>
        )}

        {citation.problem && (
          <div className={`text-[11px] leading-snug ${status === 'contradicted' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'}`}>
            {citation.problem}
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-7 text-xs"
            onClick={onView}
          >
            View source
          </Button>
          {safeUri && (
            <a
              href={safeUri}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Open original <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
