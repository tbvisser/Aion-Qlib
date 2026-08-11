import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

interface DocxCanvasViewerProps {
  url: string
  onError: (message: string) => void
}

export function DocxCanvasViewer({ url, onError }: DocxCanvasViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [rendering, setRendering] = useState(true)

  useEffect(() => {
    let cancelled = false
    const container = containerRef.current
    if (!container) return

    container.innerHTML = ''
    setRendering(true)

    ;(async () => {
      try {
        const { renderAsync } = await import('docx-preview')
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to load DOCX (HTTP ${response.status})`)
        const blob = await response.blob()
        if (cancelled) return

        await renderAsync(blob, container, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
          // SECURITY (finding E-001): DOCX is untrusted, user-controlled content.
          // docx-preview's altChunk path renders raw embedded HTML into an
          // un-sandboxed iframe.srcdoc → stored XSS in the app origin. Disable it.
          renderAltChunks: false,
        })

        if (!cancelled) setRendering(false)
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : 'Failed to render DOCX')
      }
    })()

    return () => { cancelled = true }
  }, [url, onError])

  return (
    <div className="relative h-full">
      {rendering && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      <div
        ref={containerRef}
        data-testid="docx-root"
        style={{ userSelect: 'none' }}
        className="select-none"
      />
    </div>
  )
}
