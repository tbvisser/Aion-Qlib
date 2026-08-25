import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowDown, ArrowUp, Search } from 'lucide-react'
import {
  documentMarkdownComponents,
  scrollToDocumentStructureNode,
} from '@/features/rag/components/documents/markdownHeadingTargets'
import { highlightExactText } from '@/features/rag/lib/textHighlight'
import type { DocumentRenderPage, DocumentStructureNode } from '@/features/rag/lib/api'

interface DocumentTextViewProps {
  pages: DocumentRenderPage[]
  markdownFallback?: string | null
  targetPage?: number | null
  targetNode?: DocumentStructureNode | null
  // When set, the cited passage is highlighted (amber) and scrolled into view
  // once the markdown renders — used by the citation Text view, where matching
  // the extracted text is more reliable than PDF bounding boxes.
  citationHighlight?: string | null
  // Reports whether `citationHighlight` was located in the rendered text.
  onHighlightResult?: (found: boolean) => void
  // Render each markdown page with A4 proportions. Citation previews use this
  // so extracted markdown visually matches the PDF page preview.
  pageFrame?: boolean
  // The search controls are shared by the Documents sidecar and citation panel,
  // but each sits on a different app surface.
  searchSurface?: 'card' | 'surface-1'
}

function clearSearchMarks(root: HTMLElement) {
  const marks = Array.from(root.querySelectorAll('mark[data-doc-search-match]'))
  for (const mark of marks) {
    mark.replaceWith(document.createTextNode(mark.textContent || ''))
  }
  root.normalize()
}

function markTextNode(node: Text, query: string): number {
  const text = node.nodeValue || ''
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  let matchIndex = lowerText.indexOf(lowerQuery)
  if (matchIndex === -1) return 0

  const fragment = document.createDocumentFragment()
  let lastIndex = 0
  let count = 0

  while (matchIndex !== -1) {
    if (matchIndex > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, matchIndex)))
    }

    const mark = document.createElement('mark')
    mark.dataset.docSearchMatch = 'true'
    mark.className = 'rounded bg-yellow-300/60 px-0.5 text-neutral-900'
    mark.textContent = text.slice(matchIndex, matchIndex + query.length)
    fragment.appendChild(mark)
    count += 1

    lastIndex = matchIndex + query.length
    matchIndex = lowerText.indexOf(lowerQuery, lastIndex)
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)))
  }

  node.parentNode?.replaceChild(fragment, node)
  return count
}

function highlightSearch(root: HTMLElement, query: string): number {
  clearSearchMarks(root)
  const trimmed = query.trim()
  if (!trimmed) return 0

  const textNodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement
      if (!parent || !node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT
      if (parent.closest('[data-doc-search-skip]')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text)
  }

  return textNodes.reduce((total, node) => total + markTextNode(node, trimmed), 0)
}

export function DocumentTextView({
  pages,
  markdownFallback,
  targetPage,
  targetNode,
  citationHighlight,
  onHighlightResult,
  pageFrame = false,
  searchSurface = 'card',
}: DocumentTextViewProps) {
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [activeMatch, setActiveMatch] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  const effectivePages = useMemo(() => {
    if (pages.length > 0) return pages
    if (markdownFallback) return [{ page_no: 1, markdown: markdownFallback }]
    return []
  }, [markdownFallback, pages])

  useEffect(() => {
    const root = contentRef.current
    if (!root) return
    const count = highlightSearch(root, query)
    setMatchCount(count)
    setActiveMatch(0)
  }, [effectivePages, query])

  useEffect(() => {
    const root = contentRef.current
    if (!root) return

    const marks = Array.from(root.querySelectorAll<HTMLElement>('mark[data-doc-search-match]'))
    marks.forEach((mark, index) => {
      mark.className = index === activeMatch
        ? 'rounded bg-primary px-0.5 text-primary-foreground ring-2 ring-primary/30'
        : 'rounded bg-yellow-300/60 px-0.5 text-neutral-900'
    })
    marks[activeMatch]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeMatch, matchCount])

  useEffect(() => {
    const root = contentRef.current
    if (!root) return

    const frame = requestAnimationFrame(() => {
      if (scrollToDocumentStructureNode(root, targetNode)) return
      if (!targetPage) return

      const target = root.querySelector<HTMLElement>(`[data-doc-text-page="${targetPage}"]`)
      target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })

    return () => cancelAnimationFrame(frame)
  }, [effectivePages, targetPage, targetNode])

  // Highlight the cited passage and scroll it into view. Runs after the markdown
  // has rendered and after the scroll-to-target effect above, so when a match is
  // found its scroll-into-view wins over the coarser page scroll. Reports the
  // result so the citation viewer can decide the overall status. When there's no
  // rendered text to search (empty render), report "not found".
  useEffect(() => {
    if (!citationHighlight) return
    const root = contentRef.current
    if (!root) {
      onHighlightResult?.(false)
      return
    }
    const frame = requestAnimationFrame(() => {
      onHighlightResult?.(highlightExactText(root, citationHighlight))
    })
    return () => cancelAnimationFrame(frame)
  }, [effectivePages, citationHighlight, onHighlightResult])

  if (effectivePages.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        Rendered text is unavailable for this document. Re-upload it to generate page-aware text.
      </div>
    )
  }

  const canNavigateMatches = matchCount > 0
  const pageFrameClass = pageFrame ? 'document-a4-frame mx-auto' : 'mx-auto max-w-3xl'
  const pageSheetClass = pageFrame
    ? 'document-a4-sheet rounded-md bg-white text-neutral-900 shadow-md ring-1 ring-black/5'
    : 'rounded-md bg-white px-10 py-12 text-neutral-900 shadow-md ring-1 ring-black/5'
  const searchSurfaceClass = searchSurface === 'surface-1' ? 'bg-surface-1' : 'bg-card'

  return (
    <div className="space-y-4">
      {/* Pin the search controls to the top of the scroll container so they stay
          reachable while paging through a long document. Every consumer wraps this
          view in a `p-6` scroller, so its 24px top padding would otherwise sit
          ABOVE the sticky bar and let content peek through there. `-top-6` sticks
          the bar 24px higher (flush with the scrollport top) and `-mt-6` matches
          the at-rest position, while `pt-6` keeps the controls visually inset.
          The bar keeps the content width, so there's no horizontal bleed. */}
      <div
        className={`sticky -top-6 z-10 -mt-6 flex flex-wrap items-center gap-2 border-b border-border/30 ${searchSurfaceClass} pb-3 pt-6`}
        data-doc-search-skip="true"
      >
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find in text…"
            className="h-8 w-full rounded-md border border-border/60 bg-background/70 pl-8 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            data-testid="docs-sidecar-text-search"
          />
        </div>
        <button
          type="button"
          onClick={() => setActiveMatch(matchCount === 0 ? 0 : (activeMatch - 1 + matchCount) % matchCount)}
          disabled={!canNavigateMatches}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-background/40 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Previous match"
          data-testid="docs-sidecar-text-prev"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setActiveMatch(matchCount === 0 ? 0 : (activeMatch + 1) % matchCount)}
          disabled={!canNavigateMatches}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-background/40 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Next match"
          data-testid="docs-sidecar-text-next"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
        {query.trim() && (
          <span
            className="text-xs tabular-nums text-muted-foreground"
            data-testid="docs-sidecar-text-match-count"
          >
            {matchCount > 0 ? `${activeMatch + 1}/${matchCount}` : '0'}
          </span>
        )}
      </div>

      <div ref={contentRef} className="space-y-8">
        {effectivePages.map(page => (
          <section
            key={page.page_no}
            data-doc-text-page={page.page_no}
            data-testid={`document-text-page-${page.page_no}`}
            // Clear the sticky search bar when a citation jumps to this page.
            className="scroll-mt-20"
          >
            <div className={pageFrameClass}>
              <div className="mb-2 text-label font-semibold uppercase tracking-wide text-muted-foreground">
                Page {page.page_no}
              </div>
              {/* Render each page as a white sheet with generous padding and a
                  soft shadow so the extracted text reads like the source page,
                  mirroring the PDF page preview. */}
              <div
                className={pageSheetClass}
                data-testid={`document-text-page-sheet-${page.page_no}`}
              >
                <div className="prose prose-page max-w-none text-sm">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={documentMarkdownComponents}>
                    {page.markdown || ' '}
                  </ReactMarkdown>
                </div>
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
