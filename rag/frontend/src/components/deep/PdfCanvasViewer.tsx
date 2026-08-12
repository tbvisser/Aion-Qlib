import { useEffect, useRef, useState } from 'react'
import { Loader2, ZoomIn, ZoomOut } from 'lucide-react'
import { ensurePdfWorker } from '@/lib/pdfWorker'

export interface PdfHighlight {
  page: number
  l: number
  t: number
  r: number
  b: number
  coord_origin?: string
  item_id?: string
}

interface PdfCanvasViewerProps {
  url: string
  onError: (message: string) => void
  targetPage?: number | null
  highlights?: PdfHighlight[]
}

const FIT_PADDING_PX = 8
const WIDTH_EPSILON_PX = 2
const EMPTY_HIGHLIGHTS: PdfHighlight[] = []

function getHighlightCss(
  highlight: PdfHighlight,
  scale: number,
  pageHeight: number,
): { left: number; top: number; width: number; height: number } | null {
  const leftPdf = Math.min(highlight.l, highlight.r)
  const rightPdf = Math.max(highlight.l, highlight.r)
  const topPdf = Math.max(highlight.t, highlight.b)
  const bottomPdf = Math.min(highlight.t, highlight.b)

  if (![leftPdf, rightPdf, topPdf, bottomPdf, scale, pageHeight].every(Number.isFinite)) {
    return null
  }
  if (rightPdf <= leftPdf || topPdf <= bottomPdf) {
    return null
  }

  const origin = (highlight.coord_origin || 'BOTTOMLEFT').toUpperCase()
  const top = origin === 'TOPLEFT'
    ? bottomPdf * scale
    : (pageHeight - topPdf) * scale

  return {
    left: leftPdf * scale,
    top: Math.max(0, top),
    width: Math.max(1, (rightPdf - leftPdf) * scale),
    height: Math.max(1, (topPdf - bottomPdf) * scale),
  }
}

// Walk up to the scrollable ancestor that owns the viewer's scroll position.
// Each consumer wraps the viewer in its own overflow container, so we discover
// it at runtime rather than threading a ref through every caller.
function getScrollParent(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return current
    current = current.parentElement
  }
  return null
}

export function PdfCanvasViewer({ url, onError, targetPage, highlights = EMPTY_HIGHLIGHTS }: PdfCanvasViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [rendering, setRendering] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [viewerWidth, setViewerWidth] = useState(0)
  // Bumped each time a fresh page render completes; the overlay effect keys off
  // it so highlights are (re)drawn once the page canvases exist.
  const [renderToken, setRenderToken] = useState(0)
  // When the user zooms we re-rasterize every page, which throws away the scroll
  // position. We stash the page they were reading (and how far into it) here so
  // the post-render scroll can put them back instead of jumping to the top.
  const pendingScrollAnchorRef = useRef<{ pageNo: number; fraction: number } | null>(null)
  const scrollTargetPage = targetPage ?? highlights.find(highlight => Number.isFinite(highlight.page))?.page ?? null

  // Record which page sits at the top of the viewport and the fractional offset
  // into it. Measured against the live (pre-zoom) DOM, so call before re-render.
  const captureScrollAnchor = (): { pageNo: number; fraction: number } | null => {
    const scroller = getScrollParent(viewerRef.current)
    const container = containerRef.current
    if (!scroller || !container) return null
    const scrollerTop = scroller.getBoundingClientRect().top
    for (const page of container.querySelectorAll<HTMLElement>('[data-page-no]')) {
      const rect = page.getBoundingClientRect()
      const relTop = rect.top - scrollerTop
      if (rect.height > 0 && relTop + rect.height > 0) {
        return {
          pageNo: Number(page.dataset.pageNo),
          fraction: Math.min(1, Math.max(0, -relTop / rect.height)),
        }
      }
    }
    return null
  }

  // Re-apply a captured anchor after the pages have been re-rasterized at the
  // new zoom, so the same point in the page stays under the viewport top.
  const restoreScrollAnchor = (anchor: { pageNo: number; fraction: number }) => {
    const scroller = getScrollParent(viewerRef.current)
    const container = containerRef.current
    if (!scroller || !container) return
    const page = container.querySelector<HTMLElement>(`[data-page-no="${anchor.pageNo}"]`)
    if (!page) return
    const rect = page.getBoundingClientRect()
    const pageTop = (rect.top - scroller.getBoundingClientRect().top) + scroller.scrollTop
    scroller.scrollTop = pageTop + anchor.fraction * rect.height
  }

  // Scroll to the cited text itself when we have a highlight box, centering it
  // in the viewport so footnotes / bottom-of-page citations stay visible.
  // Fall back to the top of the page when no highlight is available.
  const scrollToTarget = (pageNo: number | null | undefined) => {
    const container = containerRef.current
    if (!container) return
    const pageEl = pageNo
      ? container.querySelector<HTMLElement>(`[data-page-no="${pageNo}"]`)
      : null
    const highlight = (pageEl ?? container).querySelector<HTMLElement>('[data-testid="pdf-highlight-box"]')
    if (highlight) {
      highlight.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }
    pageEl?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return

    const updateWidth = () => {
      const nextWidth = Math.floor(viewer.getBoundingClientRect().width)
      setViewerWidth(current => Math.abs(current - nextWidth) <= WIDTH_EPSILON_PX ? current : nextWidth)
    }

    updateWidth()
    const frameId = window.requestAnimationFrame(updateWidth)
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateWidth)
    const fallbackIntervalId = resizeObserver ? null : window.setInterval(updateWidth, 750)
    resizeObserver?.observe(viewer)
    window.addEventListener('resize', updateWidth)

    return () => {
      window.cancelAnimationFrame(frameId)
      if (fallbackIntervalId) window.clearInterval(fallbackIntervalId)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [])

  useEffect(() => {
    setZoom(1)
  }, [url])

  useEffect(() => {
    let cancelled = false
    const container = containerRef.current
    if (!container) return

    container.innerHTML = ''
    setRendering(true)
    if (viewerWidth <= 0) return

    ;(async () => {
      try {
        await ensurePdfWorker()
        const pdfjs = await import('pdfjs-dist')
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to load PDF (HTTP ${response.status})`)
        const buffer = await response.arrayBuffer()
        if (cancelled) return

        const doc = await pdfjs.getDocument({ data: buffer }).promise
        if (cancelled) { doc.destroy(); return }

        try {
          const dpr = window.devicePixelRatio || 1
          for (let i = 1; i <= doc.numPages; i++) {
            if (cancelled) break
            const pdfPage = await doc.getPage(i)
            try {
              const naturalViewport = pdfPage.getViewport({ scale: 1 })
              const fitScale = Math.max(0.1, (viewerWidth - FIT_PADDING_PX) / naturalViewport.width)
              const viewport = pdfPage.getViewport({ scale: fitScale * zoom })

              const canvas = document.createElement('canvas')
              canvas.width = Math.floor(viewport.width * dpr)
              canvas.height = Math.floor(viewport.height * dpr)
              canvas.style.width = `${viewport.width}px`
              canvas.style.height = `${viewport.height}px`
              canvas.style.display = 'block'
              canvas.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)'

              const ctx = canvas.getContext('2d')
              if (!ctx) throw new Error('Could not get 2D canvas context')
              ctx.scale(dpr, dpr)

              await pdfPage.render({ canvasContext: ctx, viewport }).promise
              if (cancelled) break

              const pageWrapper = document.createElement('div')
              pageWrapper.dataset.pageNo = String(i)
              pageWrapper.dataset.testid = `pdf-page-${i}`
              pageWrapper.style.position = 'relative'
              pageWrapper.style.marginBottom = '12px'
              pageWrapper.style.scrollMarginTop = '16px'
              pageWrapper.appendChild(canvas)

              // Record geometry so the overlay effect can (re)position
              // highlight boxes later without re-rendering the page canvas.
              pageWrapper.dataset.pageScale = String(viewport.width / naturalViewport.width)
              pageWrapper.dataset.naturalHeight = String(naturalViewport.height)

              container.appendChild(pageWrapper)
            } finally {
              pdfPage.cleanup()
            }
          }
        } finally {
          if (cancelled) doc.destroy()
        }

        if (!cancelled) {
          setRendering(false)
          setRenderToken(token => token + 1)
        }
      } catch (err) {
        if (!cancelled) {
          onError(err instanceof Error ? err.message : 'Failed to render PDF')
        }
      }
    })()

    return () => { cancelled = true }
    // Heavy render depends only on the document and its display size — NOT on
    // highlights/target — so switching citations in the same document does not
    // re-fetch or re-rasterize the PDF.
  }, [url, onError, zoom, viewerWidth])

  // Draw (or redraw) highlight overlays on the already-rendered pages and pan
  // to the cited box. Runs when a render completes (renderToken) or when the
  // citation's highlights / target change — without touching the page canvases.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.querySelectorAll('[data-testid="pdf-highlight-box"]').forEach(node => node.remove())

    container.querySelectorAll<HTMLElement>('[data-page-no]').forEach(wrapper => {
      const pageNo = Number(wrapper.dataset.pageNo)
      const pageScale = Number(wrapper.dataset.pageScale)
      const naturalHeight = Number(wrapper.dataset.naturalHeight)
      if (!Number.isFinite(pageScale) || !Number.isFinite(naturalHeight)) return

      for (const highlight of highlights) {
        if (highlight.page !== pageNo) continue
        const box = getHighlightCss(highlight, pageScale, naturalHeight)
        if (!box) continue
        const overlay = document.createElement('div')
        overlay.dataset.testid = 'pdf-highlight-box'
        overlay.dataset.itemId = highlight.item_id || ''
        overlay.setAttribute('aria-hidden', 'true')
        overlay.className = 'absolute rounded-sm border border-amber-500/80 bg-amber-300/35 shadow-[0_0_0_1px_rgba(245,158,11,0.18)]'
        overlay.style.left = `${box.left}px`
        overlay.style.top = `${box.top}px`
        overlay.style.width = `${box.width}px`
        overlay.style.height = `${box.height}px`
        overlay.style.pointerEvents = 'none'
        overlay.style.zIndex = '5'
        wrapper.appendChild(overlay)
      }
    })

    const handle = window.requestAnimationFrame(() => {
      // A pending anchor means this render came from a zoom: keep the reader where
      // they were rather than snapping back to the citation/top.
      const anchor = pendingScrollAnchorRef.current
      if (anchor) {
        pendingScrollAnchorRef.current = null
        restoreScrollAnchor(anchor)
      } else {
        scrollToTarget(scrollTargetPage)
      }
    })
    return () => window.cancelAnimationFrame(handle)
  }, [renderToken, highlights, scrollTargetPage])

  // Capture the current reading position before kicking off the zoom re-render so
  // restoreScrollAnchor can put it back once the new pages are rasterized.
  const handleZoom = (delta: number) => {
    const next = Math.min(2, Math.max(0.6, Number((zoom + delta).toFixed(2))))
    if (next === zoom) return
    pendingScrollAnchorRef.current = captureScrollAnchor()
    setZoom(next)
  }

  return (
    <div
      ref={viewerRef}
      className="relative min-h-full w-full"
      data-testid="pdf-canvas-viewer"
    >
      <div className="sticky top-0 z-20 flex justify-end pr-2 pb-2 pointer-events-none" data-testid="pdf-zoom-controls">
        <div className="pointer-events-auto inline-flex items-center gap-1 rounded-md border border-border/60 bg-card/95 p-1 shadow-sm backdrop-blur">
          <button
            type="button"
            onClick={() => handleZoom(-0.15)}
            disabled={zoom <= 0.6}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Zoom out"
            title="Zoom out"
            data-testid="pdf-zoom-out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => handleZoom(0.15)}
            disabled={zoom >= 2}
            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Zoom in"
            title="Zoom in"
            data-testid="pdf-zoom-in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      </div>
      {rendering && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      <div ref={containerRef} className="flex flex-col items-center" />
    </div>
  )
}
