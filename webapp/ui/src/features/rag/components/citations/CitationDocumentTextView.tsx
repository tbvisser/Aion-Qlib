import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { getDocumentRender, type DocumentRender } from '@/features/rag/lib/api'
import { DocumentTextView } from '@/features/rag/components/documents/DocumentTextView'

interface CitationDocumentTextViewProps {
  documentId: string
  targetPage?: number | null
  // The cited passage to highlight in the extracted text. Text search here is
  // more reliable than PDF bounding boxes, so this is the better place to land
  // the user when the box can't be located on the page.
  citationExact?: string | null
  // Reports whether the cited passage was located in the extracted text, so the
  // caller can decide the overall citation status (and whether to surface the
  // "not found anywhere" drawer).
  onHighlightResult?: (found: boolean) => void
}

/**
 * Renders a cited document's extracted markdown using the same page-styled
 * viewer (and "Find in text..." search) as the Documents sidecar. Fetches the
 * render lazily — it only loads when the user switches to the Text tab.
 */
export function CitationDocumentTextView({ documentId, targetPage, citationExact, onHighlightResult }: CitationDocumentTextViewProps) {
  const [render, setRender] = useState<DocumentRender | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRender(null)
    setError(null)
    setLoading(true)
    getDocumentRender(documentId)
      .then((data) => { if (!cancelled) setRender(data) })
      .catch(() => { if (!cancelled) setError('Rendered text is unavailable for this document.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [documentId])

  // No render to search means the citation isn't locatable in the text either.
  useEffect(() => {
    if (error) onHighlightResult?.(false)
  }, [error, onHighlightResult])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error || !render) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <AlertTriangle className="h-5 w-5" />
        <div>{error || 'Rendered text is unavailable.'}</div>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <DocumentTextView
        pages={render.pages ?? []}
        markdownFallback={render.markdown}
        targetPage={targetPage}
        citationHighlight={citationExact}
        onHighlightResult={onHighlightResult}
        pageFrame
        searchSurface="surface-1"
      />
    </div>
  )
}
