import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  FileContentPreview,
  isPreviewableContentType,
  type ViewMode,
} from '@/features/rag/components/shared/FileContentPreview'
import { FallbackPanel } from '@/features/rag/components/shared/FallbackPanel'
import { PdfCanvasViewer } from '@/features/rag/components/deep/PdfCanvasViewer'
import { DocxCanvasViewer } from '@/features/rag/components/deep/DocxCanvasViewer'
import type { DocumentStructureNode } from '@/features/rag/lib/api'

const SIZE_CAP_BYTES = 20 * 1024 * 1024 // 20 MB

export interface PreviewBodyFile {
  name: string
  sizeBytes: number
  contentType: string
}

interface PreviewBodyProps {
  file: PreviewBodyFile
  fetchUrl: () => Promise<string>
  fetchTextContent: () => Promise<string>
  viewMode: ViewMode
  onDownload: () => void
  targetPage?: number | null
  targetNode?: DocumentStructureNode | null
}

function isDocx(file: PreviewBodyFile): boolean {
  if (file.contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return true
  return file.name.toLowerCase().endsWith('.docx')
}

function isPdf(file: PreviewBodyFile): boolean {
  return file.contentType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

function isImage(file: PreviewBodyFile): boolean {
  const contentType = file.contentType.toLowerCase()
  const name = file.name.toLowerCase()
  if (contentType.startsWith('image/')) return true
  return ['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'].some(ext => name.endsWith(ext))
}

export function PreviewBody({
  file,
  fetchUrl,
  fetchTextContent,
  viewMode,
  onDownload,
  targetPage,
  targetNode,
}: PreviewBodyProps) {
  const [content, setContent] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const oversized = file.sizeBytes > SIZE_CAP_BYTES
  const docx = !oversized && isDocx(file)
  const pdf = !oversized && isPdf(file)
  const image = !oversized && !docx && !pdf && isImage(file)
  const textLike = !oversized && !docx && !pdf && isPreviewableContentType(file.contentType)

  useEffect(() => {
    if (oversized) { setLoading(false); return }

    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setContent(null)
    setDownloadUrl(null)

    if (pdf || docx || image) {
      fetchUrl()
        .then(url => { if (!controller.signal.aborted) { setDownloadUrl(url); setLoading(false) } })
        .catch(err => { if (!controller.signal.aborted) { setError(err.message || 'Failed to load file'); setLoading(false) } })
    } else if (textLike) {
      fetchTextContent()
        .then(text => { if (!controller.signal.aborted) { setContent(text); setLoading(false) } })
        .catch(err => { if (!controller.signal.aborted) { setError(err.message || 'Failed to load content'); setLoading(false) } })
    } else {
      setLoading(false)
    }

    return () => controller.abort()
  }, [file.name, file.sizeBytes, file.contentType])

  if (oversized) {
    return (
      <FallbackPanel
        message="This file is too large to preview inline."
        fileName={file.name}
        onDownload={onDownload}
      />
    )
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (error) {
    return <FallbackPanel message={error} fileName={file.name} onDownload={onDownload} />
  }
  if (pdf && downloadUrl) {
    return <PdfCanvasViewer url={downloadUrl} onError={setError} targetPage={targetPage} />
  }
  if (docx && downloadUrl) {
    return <DocxCanvasViewer url={downloadUrl} onError={setError} />
  }
  if (image && downloadUrl) {
    return (
      <div className="flex h-full min-h-[240px] items-center justify-center">
        <img
          src={downloadUrl}
          alt={file.name}
          className="max-h-full max-w-full rounded-md border border-border/50 bg-background object-contain"
          data-testid="image-preview"
          onError={() => setError('Failed to load image preview')}
        />
      </div>
    )
  }
  if (textLike) {
    return (
      <FileContentPreview
        content={content}
        contentType={file.contentType}
        viewMode={viewMode}
        targetNode={targetNode}
      />
    )
  }
  return (
    <FallbackPanel message="This file cannot be previewed." fileName={file.name} onDownload={onDownload} />
  )
}
