import { useEffect, useState } from 'react'
import { X, ExternalLink, FileText, FileType, FolderOpen, Globe, AlertTriangle, Eye, Code2, ChevronDown, Camera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CitationSourceViewer, type WebViewMode } from './CitationSourceViewer'
import { citationBadgeLabel, effectiveStatus, safeWebUrl } from './citationUtils'
import { hasMultipleViews, type ViewMode } from '@/features/rag/components/shared/FileContentPreview'
import type { AnswerCitation, CitationVerificationMode } from '@/features/rag/types'

interface CitationSourcePanelProps {
  citation: AnswerCitation
  verificationMode?: CitationVerificationMode | null
  onClose: () => void
}

function SourceIcon({ kind, className }: { kind: AnswerCitation['source']['source_type']; className?: string }) {
  if (kind === 'document') return <FileText className={className} />
  if (kind === 'workspace_file') return <FolderOpen className={className} />
  return <Globe className={className} />
}

function sourceLabel(kind: AnswerCitation['source']['source_type']) {
  if (kind === 'document') return 'Document'
  if (kind === 'workspace_file') return 'Workspace file'
  return 'Web'
}

function webHost(uri?: string) {
  if (!uri) return ''
  try {
    return new URL(uri).hostname.replace(/^www\./, '')
  } catch {
    return uri
  }
}

function formatSnapshotCapturedAt(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date)
}

export function CitationSourcePanel({ citation, verificationMode, onClose }: CitationSourcePanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('rendered')
  const [webViewMode, setWebViewMode] = useState<WebViewMode>('snapshot')
  const [webSnapshotFetchedAt, setWebSnapshotFetchedAt] = useState<string | null>(null)
  const [highlightStatus, setHighlightStatus] = useState<'pending' | 'found' | 'missing'>('pending')
  const [detailsOpen, setDetailsOpen] = useState(false)
  // PDF Page/Text switch — lifted from the viewer so it can live in the header
  // alongside (and styled like) the web preview/source toggle. The viewer drives
  // the value and tells us when the switch applies to the current source.
  const [pdfView, setPdfView] = useState<'page' | 'text'>('page')
  const [textTabAvailable, setTextTabAvailable] = useState(false)
  const isWebSource = citation.source.source_type === 'web'
  const host = isWebSource ? webHost(citation.source.uri) : ''
  // Only expose the source URI as a real link when it's a safe http(s) URL.
  const safeSourceUri = safeWebUrl(citation.source.uri)
  const status = effectiveStatus(citation.status, verificationMode)
  const contentType = citation.source.content_type
  const showViewToggle = !isWebSource && contentType && hasMultipleViews(contentType)
  const formattedSnapshotFetchedAt = formatSnapshotCapturedAt(webSnapshotFetchedAt)

  useEffect(() => {
    setWebViewMode('snapshot')
    setWebSnapshotFetchedAt(null)
  }, [citation.citation_id])

  // When the source viewer can't pin the exact location (no bounding box for a
  // PDF, or the quote isn't found in the text), auto-expand this drawer so the
  // cited passage and the "not found" notice are visible. Once a citation with
  // a precise highlight is shown — e.g. clicking another citation in the same
  // document whose bounding box was located — collapse it again.
  useEffect(() => {
    if (highlightStatus === 'missing') setDetailsOpen(true)
    else if (highlightStatus === 'found') setDetailsOpen(false)
  }, [highlightStatus])

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="citation-source-panel">
      {/* Header */}
      {isWebSource ? (
        <div className="border-b border-border/50 px-4 py-3 shrink-0">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Globe className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold" title={citation.source.title}>
                {citation.source.title || 'Web source'}
              </div>
              <div className="truncate text-xs text-muted-foreground" title={citation.source.uri}>
                {host || citation.source.uri || 'web source'}
              </div>
            </div>
            {safeSourceUri && (
              <a
                href={safeSourceUri}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-border/60 bg-background px-3 text-sm font-medium transition-colors hover:bg-accent/50 hover:text-accent-foreground"
              >
                <ExternalLink className="h-4 w-4" />
                Open in new tab
              </a>
            )}
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} title="Close" data-testid="citation-panel-close">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center rounded-md border border-border/50 bg-surface-2 p-0.5" role="group" aria-label="Web source view">
              <button
                type="button"
                onClick={() => setWebViewMode('snapshot')}
                aria-pressed={webViewMode === 'snapshot'}
                className={cn('h-8 rounded px-3 text-sm font-medium transition-colors', webViewMode === 'snapshot' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              >
                Snapshot
              </button>
              <button
                type="button"
                onClick={() => setWebViewMode('live')}
                aria-pressed={webViewMode === 'live'}
                className={cn('h-8 rounded px-3 text-sm font-medium transition-colors', webViewMode === 'live' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              >
                Live page
              </button>
            </div>
            <div className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Camera className="h-3.5 w-3.5" />
              <span>
                {formattedSnapshotFetchedAt
                  ? `Snapshot captured ${formattedSnapshotFetchedAt}`
                  : 'Snapshot view'}
              </span>
            </div>
          </div>
        </div>
      ) : (
      <div className="flex items-start gap-2 border-b border-border/50 px-4 py-3 shrink-0">
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          <SourceIcon kind={citation.source.source_type} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-micro uppercase tracking-wide text-muted-foreground">
            <span>{sourceLabel(citation.source.source_type)}</span>
            <span aria-hidden>·</span>
            <span>Citation #{citation.display_number}</span>
          </div>
          <div className="text-sm font-semibold truncate" title={citation.source.title}>
            {citation.source.title}
          </div>
        </div>
        {showViewToggle && (
          <div className="inline-flex items-center rounded-md border border-border/50 bg-surface-2 p-0.5 shrink-0" role="group" aria-label="View mode">
            <button
              type="button"
              onClick={() => setViewMode('rendered')}
              aria-pressed={viewMode === 'rendered'}
              title="Preview"
              className={cn('flex items-center justify-center h-6 w-7 rounded transition-colors', viewMode === 'rendered' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('source')}
              aria-pressed={viewMode === 'source'}
              title="Source"
              className={cn('flex items-center justify-center h-6 w-7 rounded transition-colors', viewMode === 'source' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              <Code2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {!showViewToggle && textTabAvailable && (
          <div className="inline-flex items-center rounded-md border border-border/50 bg-surface-2 p-0.5 shrink-0" role="group" aria-label="Citation view">
            <button
              type="button"
              onClick={() => setPdfView('page')}
              aria-pressed={pdfView === 'page'}
              title="Page"
              className={cn('flex items-center justify-center h-6 w-7 rounded transition-colors', pdfView === 'page' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              data-testid="citation-view-page"
            >
              <FileType className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setPdfView('text')}
              aria-pressed={pdfView === 'text'}
              title="Text"
              className={cn('flex items-center justify-center h-6 w-7 rounded transition-colors', pdfView === 'text' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              data-testid="citation-view-text"
            >
              <FileText className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose} title="Close" data-testid="citation-panel-close">
          <X className="h-4 w-4" />
        </Button>
      </div>
      )}

      {/* Citation metadata */}
      <div className="border-b border-border/40 shrink-0">
        <button
          type="button"
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
          className="flex w-full items-center gap-2 px-4 py-2 text-xs text-left hover:bg-muted/30 transition-colors"
        >
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 font-medium',
              status === 'verified'
                ? 'bg-primary/10 text-primary'
                : status === 'partially_supported' || status === 'not_verified' || status === 'verification_failed'
                ? 'bg-clay/10 text-clay'
                : status === 'contradicted'
                ? 'bg-destructive/10 text-destructive'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {citationBadgeLabel(citation.status, verificationMode)}
          </span>
          <ChevronDown
            className={cn('ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform', detailsOpen && 'rotate-180')}
          />
        </button>

        {detailsOpen && (
          <div className="space-y-2 px-4 pb-3 text-xs">
            {citation.problem && (
              <div className={cn('text-label leading-snug', status === 'contradicted' ? 'text-destructive' : 'text-clay')}>
                {citation.problem}
              </div>
            )}
            {citation.quote && (
              <div className="rounded-sm bg-muted/30 px-2 py-1.5">
                <div className="mb-1 text-micro uppercase tracking-wide text-muted-foreground">Cited passage</div>
                <blockquote className="leading-snug border-l-2 border-border pl-2">
                  {citation.quote}
                </blockquote>
              </div>
            )}
            {highlightStatus === 'missing' && (
              <div className="flex items-center gap-1 text-micro text-clay">
                <AlertTriangle className="h-3 w-3" />
                Exact location not found in the source - showing the cited passage above.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col">
        <CitationSourceViewer
          citation={citation}
          viewMode={viewMode}
          webViewMode={webViewMode}
          onHighlightStatus={setHighlightStatus}
          onWebSnapshotFetchedAtChange={setWebSnapshotFetchedAt}
          pdfView={pdfView}
          onPdfViewChange={setPdfView}
          onTextTabAvailableChange={setTextTabAvailable}
        />
      </div>

      {/* Footer */}
      {safeSourceUri && !isWebSource && (
        <div className="border-t border-border/40 px-4 py-2 shrink-0">
          <a
            href={safeSourceUri}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Open original <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  )
}
