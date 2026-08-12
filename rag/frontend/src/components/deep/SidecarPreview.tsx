import { useState, useEffect, useCallback } from 'react'
import { X, Download, Eye, Code2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getWorkspaceFileContent, getWorkspaceFileDownloadUrl } from '@/lib/api'
import {
  hasMultipleViews,
  type ViewMode,
} from '@/components/shared/FileContentPreview'
import { PreviewBody } from '@/components/shared/PreviewBody'
import type { WorkspaceFile } from '@/types'

interface SidecarPreviewProps {
  file: WorkspaceFile
  threadId: string
  onClose: () => void
}

export function SidecarPreview({ file, threadId, onClose }: SidecarPreviewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('rendered')

  const oversized = file.size_bytes > 20 * 1024 * 1024
  const showViewToggle = !oversized && hasMultipleViews(file.content_type)

  // Reset to rendered view whenever the file changes
  useEffect(() => { setViewMode('rendered') }, [file])

  // Esc closes preview
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleDownload = useCallback(async () => {
    try {
      const url = await getWorkspaceFileDownloadUrl(threadId, file.file_path)
      window.open(url, '_blank')
    } catch {
      // ignore
    }
  }, [threadId, file.file_path])

  return (
    <div className="flex flex-col h-full min-h-0" data-testid="sidecar-preview">
      {/* Header */}
      <div
        className="flex items-center gap-3 border-b border-border/50 px-4 py-3 shrink-0"
        data-testid="sidecar-preview-header"
      >
        {showViewToggle && (
          <div
            className="inline-flex items-center rounded-md border border-border/50 bg-surface-2 p-0.5 shrink-0"
            role="group"
            aria-label="View mode"
          >
            <button
              type="button"
              onClick={() => setViewMode('rendered')}
              aria-label="Preview"
              title="Preview"
              aria-pressed={viewMode === 'rendered'}
              className={`flex items-center justify-center h-6 w-7 rounded transition-colors ${
                viewMode === 'rendered'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('source')}
              aria-label="Source"
              title="Source"
              aria-pressed={viewMode === 'source'}
              className={`flex items-center justify-center h-6 w-7 rounded transition-colors ${
                viewMode === 'source'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <span className="text-sm font-semibold text-foreground truncate flex-1" title={file.file_path}>
          {file.file_path}
        </span>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleDownload} title="Download">
          <Download className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={onClose}
          title="Close"
          data-testid="sidecar-close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Body */}
      <div
        className="min-h-0 flex-1 overflow-x-auto overflow-y-scroll p-6 [scrollbar-gutter:stable]"
        data-testid="sidecar-preview-content"
      >
        <PreviewBody
          file={{
            name: file.file_path,
            sizeBytes: file.size_bytes,
            contentType: file.content_type,
          }}
          fetchUrl={() => getWorkspaceFileDownloadUrl(threadId, file.file_path)}
          fetchTextContent={() => getWorkspaceFileContent(threadId, file.file_path)}
          viewMode={viewMode}
          onDownload={handleDownload}
        />
      </div>
    </div>
  )
}
