import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Loader2, AlertTriangle, Globe, ExternalLink } from 'lucide-react'
import {
  getDocumentChunks,
  getDocumentDownloadUrl,
  getDocumentRender,
  getWorkspaceFileContent,
  getWorkspaceFileDownloadUrl,
  fetchApi,
} from '@/features/rag/lib/api'
import {
  FileContentPreview,
  isPreviewableContentType,
  hasMultipleViews,
  isMarkdownContentType,
  type ViewMode,
} from '@/features/rag/components/shared/FileContentPreview'
import { PdfCanvasViewer, type PdfHighlight } from '@/features/rag/components/deep/PdfCanvasViewer'
import { DocxCanvasViewer } from '@/features/rag/components/deep/DocxCanvasViewer'
import { CitationDocumentTextView } from '@/features/rag/components/citations/CitationDocumentTextView'
import { highlightExactText } from '@/features/rag/lib/textHighlight'
import { safeWebUrl } from './citationUtils'
import type { AnswerCitation } from '@/features/rag/types'

export type WebViewMode = 'snapshot' | 'live'

interface CitationSourceViewerProps {
  citation: AnswerCitation
  viewMode: ViewMode
  webViewMode?: WebViewMode
  onHighlightStatus?: (status: 'pending' | 'found' | 'missing') => void
  onWebSnapshotFetchedAtChange?: (fetchedAt: string | null) => void
  // The Page/Text switch lives in the panel header (so it matches the web
  // preview/source toggle), so its state is lifted to the panel and driven here.
  pdfView?: 'page' | 'text'
  onPdfViewChange?: (view: 'page' | 'text') => void
  // Reports whether the Page/Text switch applies to the current source (a PDF
  // document with a server-side render), so the header can show/hide it.
  onTextTabAvailableChange?: (available: boolean) => void
}

interface LoadedSource {
  contentType: string
  // either text content or a URL we can hand to a canvas viewer
  textContent?: string
  fileUrl?: string
  filename: string
  sizeBytes?: number
  // Web source with no stored snapshot: render a link-only fallback instead of
  // dumping the raw URL as the body.
  webLinkOnly?: boolean
  uri?: string
  fetchedAt?: string | null
}

function inferContentTypeFromName(name: string, fallback?: string): string {
  if (fallback && fallback !== 'application/octet-stream') return fallback
  const lower = name.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return fallback || 'text/plain'
}

async function loadRenderedDocumentText(documentId: string): Promise<string | null> {
  try {
    const rendered = await getDocumentRender(documentId)
    const markdown = rendered.markdown || rendered.pages.map((page) => page.markdown).filter(Boolean).join('\n\n')
    if (markdown?.trim()) return markdown
  } catch {
    // Fall through to chunk text. Some local databases may not have render
    // metadata yet, but all chunk text is still enough for exact citation jumps.
  }

  try {
    const chunks = await getDocumentChunks(documentId)
    const text = chunks.map((chunk) => chunk.content).filter(Boolean).join('\n\n---\n\n')
    return text.trim() ? text : null
  } catch {
    return null
  }
}

async function loadSource(citation: AnswerCitation): Promise<LoadedSource> {
  const { source } = citation
  if (source.source_type === 'document' && source.document_id) {
    const meta = await getDocumentDownloadUrl(source.document_id)
    const actualContentType = inferContentTypeFromName(source.title, meta.file_type)
    const citationContentType = source.content_type || actualContentType
    // Citation spans for parsed PDFs/DOCX files are text-like even when the
    // original upload is binary, so load the rendered extraction for exact
    // quote highlighting instead of treating raw file bytes as text.
    if (isPreviewableContentType(citationContentType)) {
      const renderedText = await loadRenderedDocumentText(source.document_id)
      if (renderedText) {
        return { contentType: citationContentType, textContent: renderedText, filename: source.title }
      }
    }
    if (isPreviewableContentType(actualContentType)) {
      const res = await fetch(meta.url)
      if (!res.ok) throw new Error(`Failed to fetch source (HTTP ${res.status})`)
      const text = await res.text()
      return { contentType: actualContentType, textContent: text, filename: source.title }
    }
    return { contentType: actualContentType, fileUrl: meta.url, filename: source.title }
  }

  if (source.source_type === 'workspace_file' && source.thread_id && source.file_path) {
    const contentType = source.content_type || inferContentTypeFromName(source.file_path)
    if (isPreviewableContentType(contentType)) {
      const text = await getWorkspaceFileContent(source.thread_id, source.file_path)
      return { contentType, textContent: text, filename: source.file_path }
    }
    const url = await getWorkspaceFileDownloadUrl(source.thread_id, source.file_path)
    return { contentType, fileUrl: url, filename: source.file_path }
  }

  if (source.source_type === 'web') {
    // Fetch the captured page snapshot by stable source_id — works for both a
    // freshly-streamed citation (transient cite_ id) and one reloaded from the
    // DB (uuid). Falls back to a link-only view when no snapshot was captured.
    try {
      const snap = await fetchApi<{ content_type: string | null; content: string | null; uri?: string | null; fetched_at?: string | null }>(
        `/citations/web-source/${encodeURIComponent(source.source_id)}`,
      )
      if (snap.content) {
        return {
          contentType: snap.content_type || 'text/markdown',
          textContent: snap.content,
          filename: source.title || snap.uri || source.uri || 'web source',
          uri: snap.uri || source.uri,
          fetchedAt: snap.fetched_at ?? null,
        }
      }
    } catch {
      // fall through to link-only fallback
    }
    return { contentType: 'text/plain', filename: source.title, webLinkOnly: true, uri: source.uri }
  }

  throw new Error('Unknown source type')
}

// Identifies the underlying file/source behind a citation. Two citations into
// the same document share a key, so we can reuse an already-loaded source
// instead of re-fetching it.
function citationSourceKey(citation: AnswerCitation): string {
  const { source } = citation
  if (source.source_type === 'document' && source.document_id) return `document:${source.document_id}`
  if (source.source_type === 'workspace_file') return `workspace:${source.thread_id ?? ''}:${source.file_path ?? ''}`
  if (source.source_type === 'web') return `web:${source.source_id || source.uri || citation.citation_id}`
  return `citation:${citation.citation_id}`
}

export function CitationSourceViewer({
  citation,
  viewMode,
  webViewMode = 'snapshot',
  onHighlightStatus,
  onWebSnapshotFetchedAtChange,
  pdfView = 'page',
  onPdfViewChange,
  onTextTabAvailableChange,
}: CitationSourceViewerProps) {
  const [loaded, setLoaded] = useState<LoadedSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // verbatim) and highlight there — mirroring the PDF page→text fallback.
  const containerRef = useRef<HTMLDivElement>(null)
  const sourceKey = citationSourceKey(citation)
  const pdfHighlights = useMemo<PdfHighlight[]>(() => {
    return (citation.target.bboxes ?? []).filter((box): box is PdfHighlight =>
      typeof box?.page === 'number'
      && typeof box.l === 'number'
      && typeof box.t === 'number'
      && typeof box.r === 'number'
      && typeof box.b === 'number',
    )
  }, [citation.target.bboxes])
  // The extracted-text view is only available for ingested documents (where a
  // server-side render exists). Workspace-file PDFs only get the page view.
  const textTabDocumentId =
    citation.source.source_type === 'document' ? citation.source.document_id ?? undefined : undefined
  const hasTextTab = Boolean(textTabDocumentId)

  // Reload only when the underlying source changes. The selected citation's
  // target/exact quote still flows through props, so same-source citation clicks
  // simply re-highlight and pan within the already-loaded page/document.
  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setError(null)
    setLoading(true)
    onHighlightStatus?.('pending')
    onWebSnapshotFetchedAtChange?.(null)
    loadSource(citation)
      .then((s) => {
        if (cancelled) return
        setLoaded(s)
        setLoading(false)
        onWebSnapshotFetchedAtChange?.(
          citation.source.source_type === 'web' && !s.webLinkOnly ? s.fetchedAt ?? null : null,
        )
      })
      .catch((e) => { if (!cancelled) { setError(e.message || 'Failed to load source'); setLoading(false) } })
    return () => { cancelled = true }
  }, [sourceKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onHighlightStatus?.('pending')
  }, [citation.citation_id, citation.target.exact, onHighlightStatus])

  // Decide which view to show for the selected citation:
  // - Every citation click defaults to the page (PDF) view, so clicking a
  //   citation always tries the PDF preview first — including across citations
  //   in the same document the user had previously switched to text for.
  // - With no bounding box the page can't show the citation, so fall to the
  //   text view (text search is more reliable than boxes).
  // useLayoutEffect so the switch happens before paint — no flash of the empty
  // page view before we drop to text. Keyed on the citation (not pdfView) so a
  // manual switch to text still sticks for that citation; the next click resets.
  useLayoutEffect(() => {
    const next = pdfHighlights.length === 0 && hasTextTab ? 'text' : 'page'
    if (next !== pdfView) onPdfViewChange?.(next)
  }, [citation.citation_id, sourceKey, pdfHighlights.length, hasTextTab]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the panel whether the Page/Text switch applies to this source so it can
  // render that toggle in the header (only ingested PDFs have a server render).
  useEffect(() => {
    onTextTabAvailableChange?.(loaded?.contentType === 'application/pdf' && hasTextTab)
  }, [loaded, hasTextTab, onTextTabAvailableChange])

  // Apply highlight after content renders
  useEffect(() => {
    if (citation.source.source_type === 'web' && webViewMode === 'live') {
      onHighlightStatus?.('found')
      return
    }
    if (!loaded?.textContent) return
    const handle = requestAnimationFrame(() => {
      const root = containerRef.current
      if (!root) return
      const found = highlightExactText(root, citation.target.exact)
      // Web snapshot: if the rendered preview can't locate the cited passage,
      // fall back to the raw source view (where it matches verbatim) and
      // highlight there before reporting a verdict — mirrors PDF page→text.
      const isWeb = citation.source.source_type === 'web'
      if (isWeb) {
        onHighlightStatus?.('found')
        return
      }
      onHighlightStatus?.(found ? 'found' : 'missing')
    })
    return () => cancelAnimationFrame(handle)
  }, [loaded, citation.target, viewMode, citation.citation_id, webViewMode, onHighlightStatus])

  // Status for PDF citations reflects whether the citation is locatable at all:
  // a bounding box counts as found; with no box we defer to the text view's
  // verdict (it auto-opens) and report 'missing' only when there's no text
  // fallback. The drawer (driven by this status) then surfaces only when the
  // citation can't be located in the PDF *or* the text.
  useEffect(() => {
    if (!loaded || loaded.textContent || loaded.contentType !== 'application/pdf') return
    if (pdfHighlights.length > 0) {
      onHighlightStatus?.('found')
    } else if (!hasTextTab) {
      onHighlightStatus?.('missing')
    } else {
      onHighlightStatus?.('pending')
    }
  }, [loaded, pdfHighlights.length, hasTextTab, citation.citation_id, onHighlightStatus])

  // The text view reports whether it located the cited passage. It only decides
  // the verdict when the page had no bounding box — otherwise the box already
  // counts as found and we leave that status (and the user's view) untouched.
  const handleTextHighlightResult = useCallback(
    (found: boolean) => {
      if (pdfHighlights.length === 0) onHighlightStatus?.(found ? 'found' : 'missing')
    },
    [pdfHighlights.length, onHighlightStatus],
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (error || !loaded) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center text-sm text-muted-foreground gap-2">
        <AlertTriangle className="h-5 w-5" />
        <div>{error || 'Source could not be loaded.'}</div>
      </div>
    )
  }

  // PDF
  if (loaded.contentType === 'application/pdf' && loaded.fileUrl) {
    const targetPage = citation.target.page ?? pdfHighlights[0]?.page ?? null
    const showTextTab = hasTextTab
    return (
      <div className="flex flex-col h-full min-h-0">
        {showTextTab && pdfView === 'text' ? (
          <CitationDocumentTextView
            documentId={textTabDocumentId!}
            targetPage={targetPage}
            citationExact={citation.target.exact}
            onHighlightResult={handleTextHighlightResult}
          />
        ) : (
          <>
            {targetPage && pdfHighlights.length === 0 && (
              <div className="px-4 py-1.5 text-xs text-muted-foreground border-b border-border/40 bg-muted/30">
                Cited on page {targetPage}. Highlight boxes are unavailable for this source.
              </div>
            )}
            {/* Keep the vertical scrollbar (and its gutter) always present so the
                PDF render width never changes when content grows. Without this the
                scrollbar appears/disappears, the viewer's ResizeObserver re-fires,
                and the canvas flickers continuously — same fix as the docs sidecar. */}
            <div className="flex-1 min-h-0 overflow-x-auto overflow-y-scroll [scrollbar-gutter:stable]">
              <PdfCanvasViewer
                url={loaded.fileUrl}
                onError={setError}
                targetPage={targetPage}
                highlights={pdfHighlights}
              />
            </div>
          </>
        )}
      </div>
    )
  }
  // DOCX
  const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (loaded.contentType === docxType && loaded.fileUrl) {
    return (
      <div className="flex-1 min-h-0 overflow-auto">
        <DocxCanvasViewer url={loaded.fileUrl} onError={setError} />
      </div>
    )
  }
  // Web source with no captured snapshot — show the cited passage + a link to
  // the original instead of dumping the raw URL as the body.
  const renderWebChrome = (rawUri: string) => {
    let host = ''
    let path = ''
    try {
      const u = new URL(rawUri)
      host = u.hostname.replace(/^www\./, '')
      path = (u.pathname + u.search).replace(/\/$/, '')
    } catch {
      host = rawUri
    }

    return (
      <div className="flex items-center gap-2 border-b border-border/40 bg-muted/40 px-3 py-2 shrink-0">
        <div className="hidden items-center gap-1.5 shrink-0 sm:flex" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-border/50 bg-background px-3 py-1">
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-xs">
            <span className="text-foreground">{host || 'web source'}</span>
            <span className="text-muted-foreground">{path}</span>
          </span>
        </div>
      </div>
    )
  }

  const isProbablyPdfUrl = (rawUri: string) => {
    try {
      return new URL(rawUri).pathname.toLowerCase().endsWith('.pdf')
    } catch {
      return rawUri.toLowerCase().split(/[?#]/)[0].endsWith('.pdf')
    }
  }

  const renderOpenInNewTab = (rawUri: string, className = '') => {
    const safe = safeWebUrl(rawUri)
    if (!safe) return null
    return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex w-fit items-center justify-center gap-2 rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent/50 hover:text-accent-foreground ${className}`}
    >
      <ExternalLink className="h-4 w-4" />
      Open in new tab
    </a>
    )
  }

  const renderLivePage = (rawUri: string) => {
    // Web-citation URIs are attacker-influenced; only frame/link real http(s)
    // URLs. A javascript:/data: URL here would otherwise run in the app origin.
    const safe = safeWebUrl(rawUri)
    return (
    <div className="flex h-full min-h-0 flex-col">
      {renderWebChrome(rawUri)}
      {!safe ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          No live URL is available for this source.
        </div>
      ) : isProbablyPdfUrl(safe) ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          <div className="max-w-md space-y-1">
            <div className="text-sm font-medium text-foreground">PDF live previews are usually blocked by Chrome.</div>
            <p className="text-sm text-muted-foreground">
              Use the saved snapshot for citation context, or open the PDF in a new tab to read the live file.
            </p>
          </div>
          {renderOpenInNewTab(safe)}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 border-b border-border/40 bg-muted/25 px-4 py-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1">
              Live pages are best-effort. If this site refuses to connect, appears blank, or is blocked by Chrome, open it in a new tab.
            </span>
            {renderOpenInNewTab(safe, 'shrink-0 py-1 text-xs')}
          </div>
          <iframe
            src={safe}
            title={citation.source.title || 'Live web page'}
            className="min-h-0 flex-1 border-0 bg-white"
            sandbox="allow-forms allow-popups allow-scripts"
            referrerPolicy="no-referrer"
            data-testid="web-live-iframe"
          />
        </>
      )}
    </div>
    )
  }

  if (loaded.webLinkOnly) {
    if (webViewMode === 'live') {
      return renderLivePage(loaded.uri || citation.source.uri || '')
    }

    let domain = ''
    try {
      domain = loaded.uri ? new URL(loaded.uri).hostname.replace(/^www\./, '') : ''
    } catch {
      domain = ''
    }
    return (
      <div className="flex flex-col h-full min-h-0 overflow-auto p-6 gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Globe className="h-4 w-4 shrink-0" />
          <span className="truncate">{domain || loaded.uri || 'web source'}</span>
        </div>
        {citation.quote && (
          <blockquote className="rounded-r border-l-2 border-clay/30 bg-clay/10 px-3 py-2 text-sm leading-relaxed">
            {citation.quote}
          </blockquote>
        )}
        {loaded.uri && renderOpenInNewTab(loaded.uri)}
        <p className="text-xs text-muted-foreground">
          A saved snapshot isn’t available for this source. Showing the cited passage above — open the
          original to read the full page.
        </p>
      </div>
    )
  }
  // Web snapshot — render like a mini browser: an address bar showing the site,
  // then the captured page (rendered markdown) on a white "page" with the cited
  // passage highlighted.
  if (citation.source.source_type === 'web' && loaded.textContent != null) {
    const rawUri = loaded.uri || citation.source.uri || ''
    if (webViewMode === 'live') {
      return renderLivePage(rawUri)
    }

    // Prefer the rendered preview; auto-fall back to the raw source view when
    // the cited passage can't be highlighted in the preview (set by the
    // highlight effect). A manual toggle still wins (it resets the fallback).
    return (
      <div className="flex h-full min-h-0 flex-col">
        {renderWebChrome(rawUri)}
        {false && (
          <div className="border-b border-border/40 bg-muted/30 px-4 py-1.5 text-label text-muted-foreground shrink-0">
            Couldn’t locate the cited passage in the page preview — showing the raw captured source with the passage highlighted.
          </div>
        )}
        {/* white page (light-theme island so text stays dark even in dark mode) */}
        <div ref={containerRef} className="citation-web-page min-h-0 flex-1 overflow-auto bg-white px-6 py-5 text-slate-900">
          <FileContentPreview
            content={loaded.textContent}
            contentType={loaded.contentType}
            viewMode="rendered"
            forceLight
          />
        </div>
      </div>
    )
  }
  // Text-like (with highlight support)
  if (loaded.textContent != null) {
    const effectiveMode = hasMultipleViews(loaded.contentType) ? viewMode : 'rendered'
    return (
      <div ref={containerRef} className="flex-1 min-h-0 overflow-auto p-6">
        <FileContentPreview
          content={loaded.textContent}
          contentType={loaded.contentType}
          viewMode={effectiveMode}
          pageFrame={isMarkdownContentType(loaded.contentType)}
        />
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center h-full p-6 text-sm text-muted-foreground">
      This source cannot be previewed.
    </div>
  )
}
