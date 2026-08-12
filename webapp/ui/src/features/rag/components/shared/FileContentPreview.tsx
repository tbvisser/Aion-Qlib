import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  documentMarkdownComponents,
  scrollToDocumentStructureNode,
} from '@/features/rag/components/documents/markdownHeadingTargets'
import type { DocumentStructureNode } from '@/features/rag/lib/api'

export type ViewMode = 'rendered' | 'source'

interface FileContentPreviewProps {
  content: string | null
  contentType: string
  viewMode?: ViewMode
  targetNode?: DocumentStructureNode | null
  /**
   * Render dark-text-on-light regardless of the app theme. Used by the web
   * citation snapshot, which is shown on a white "page" to mimic a browser.
   */
  forceLight?: boolean
  /**
   * Wrap rendered markdown in an A4-shaped page. Used by citation document
   * previews so markdown sources visually match PDF page previews.
   */
  pageFrame?: boolean
}

export function isMarkdownContentType(contentType: string): boolean {
  return contentType === 'text/markdown' || contentType.endsWith('/markdown')
}

function isHtml(contentType: string): boolean {
  return contentType === 'text/html' || contentType === 'application/xhtml+xml'
}

export function hasMultipleViews(contentType: string): boolean {
  return isMarkdownContentType(contentType) || isHtml(contentType)
}

export function FileContentPreview({
  content,
  contentType,
  viewMode = 'rendered',
  targetNode,
  forceLight = false,
  pageFrame = false,
}: FileContentPreviewProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const proseClass = pageFrame
    ? 'prose prose-page max-w-none text-sm'
    : forceLight
    ? 'prose prose-neutral max-w-none text-sm'
    : 'prose prose-neutral dark:prose-invert max-w-none text-sm'
  const preClass = forceLight
    ? 'text-sm font-mono whitespace-pre-wrap break-words text-slate-800'
    : 'text-sm font-mono whitespace-pre-wrap break-words text-foreground'

  useEffect(() => {
    if (!content || !isMarkdownContentType(contentType) || viewMode !== 'rendered') return

    const frame = requestAnimationFrame(() => {
      scrollToDocumentStructureNode(contentRef.current, targetNode)
    })

    return () => cancelAnimationFrame(frame)
  }, [content, contentType, targetNode, viewMode])

  if (hasMultipleViews(contentType) && content) {
    if (viewMode === 'rendered') {
      if (isMarkdownContentType(contentType)) {
        const markdown = (
          <div ref={contentRef} className={proseClass}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={documentMarkdownComponents}>
              {content}
            </ReactMarkdown>
          </div>
        )

        return pageFrame ? (
          <div className="document-a4-frame mx-auto">
            <div
              className="document-a4-sheet rounded-md bg-white text-neutral-900 shadow-md ring-1 ring-black/5"
              data-testid="markdown-page-sheet"
            >
              {markdown}
            </div>
          </div>
        ) : markdown
      }

      return (
        <iframe
          srcDoc={content}
          className="w-full h-full border-0 rounded bg-white"
          sandbox=""
          title="HTML preview"
        />
      )
    }
    return <pre className={preClass}>{content}</pre>
  }

  if (content) {
    return <pre className={preClass}>{content}</pre>
  }

  return null
}

/**
 * Determine if a content type can be previewed as text (text, markdown, HTML, JSON).
 * PDFs are handled separately via PdfCanvasViewer and are NOT included here.
 */
export function isPreviewableContentType(contentType: string): boolean {
  if (contentType.startsWith('text/')) return true
  if (contentType === 'application/json') return true
  if (contentType === 'application/sql') return true
  if (contentType === 'application/xml') return true
  if (contentType === 'application/yaml') return true
  if (contentType === 'application/x-yaml') return true
  return false
}
