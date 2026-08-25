import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { getDocumentDownloadUrl } from '@/features/rag/lib/api'
import { ensurePdfWorker } from '@/features/rag/lib/pdfWorker'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'
import type { Document, Folder } from '@/features/rag/types'
import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import {
  FolderIcon,
  FileText,
  FileType,
  FileSpreadsheet,
  FileImage,
  File,
  Loader2,
  CheckCircle2,
  Clock3,
  XCircle,
  RefreshCcw,
  Search,
  X,
} from 'lucide-react'
import { DocumentContextMenu } from './DocumentContextMenu'
import { DocumentBulkActionsBar } from './DocumentBulkActionsBar'
import { EmptyFolderState } from './EmptyFolderState'

interface DocumentListProps {
  folders: Folder[]
  documents: Document[]
  loading: boolean
  hasMore: boolean
  currentFolderId: string | null
  searchValue: string
  searchActive: boolean
  onSearchChange: (value: string) => void
  onLoadMore: () => void
  onSelectFolder: (folderId: string | null, folderName: string | null) => void
  onSelectDocument: (doc: Document) => void
  onDeleteDocument: (doc: Document) => Promise<void>
  onRetryDocument: (doc: Document) => Promise<void>
  onBulkDelete: (ids: string[]) => Promise<void>
  onBulkMove: (ids: string[], folderId: string | null) => Promise<void>
  onAddFiles?: () => void
}

type SortOption = 'uploaded_desc' | 'name_asc' | 'name_desc'
type StatusFilter = 'all' | 'pending' | 'completed' | 'processing' | 'failed'
type FileTypeFilter = 'all' | 'pdf' | 'word' | 'excel' | 'image' | 'text'

const PDF_THUMBNAIL_MAX_BYTES = 12 * 1024 * 1024
const TEXT_THUMBNAIL_MAX_BYTES = 512 * 1024
const THUMBNAIL_CROP_RATIO = 0.52
const PDF_THUMBNAIL_INSET_X_RATIO = 0.08
const PDF_THUMBNAIL_INSET_Y_RATIO = 0.08

function StatusIcon({ status }: { status: Document['status'] }) {
  const styles = {
    pending: 'border-clay/30 bg-clay/10 text-clay',
    processing: 'border-border/50 bg-muted text-muted-foreground',
    completed: 'border-primary/20 bg-primary/10 text-primary',
    failed: 'border-destructive/20 bg-destructive/10 text-destructive',
  }
  const labels = {
    pending: 'Pending',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
  }
  const icons = {
    pending: Clock3,
    processing: Loader2,
    completed: CheckCircle2,
    failed: XCircle,
  }
  const IconComponent = icons[status]

  return (
    <span
      aria-label={labels[status]}
      title={labels[status]}
      className={cn('absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border shadow-sm', styles[status])}
    >
      <IconComponent className={cn('h-4 w-4', status === 'processing' && 'animate-spin')} aria-hidden="true" />
    </span>
  )
}

function getFileTypeIcon(fileType: string | undefined) {
  const type = (fileType || '').toLowerCase()
  if (type.includes('pdf')) return FileType
  if (type.includes('word') || type.includes('document')) return FileText
  if (type.includes('excel') || type.includes('spreadsheet')) return FileSpreadsheet
  if (type.includes('image') || type.includes('png') || type.includes('jpg') || type.includes('jpeg')) return FileImage
  if (type.includes('text') || type.includes('markdown')) return FileText
  return File
}

function getFileTypeCategory(fileType: string | undefined): FileTypeFilter {
  const type = (fileType || '').toLowerCase()
  if (type.includes('pdf')) return 'pdf'
  if (type.includes('word') || type.includes('document')) return 'word'
  if (type.includes('excel') || type.includes('spreadsheet')) return 'excel'
  if (type.includes('image') || type.includes('png') || type.includes('jpg') || type.includes('jpeg')) return 'image'
  if (type.includes('text') || type.includes('markdown')) return 'text'
  return 'all'
}

function isPdf(fileType: string | undefined): boolean {
  return (fileType || '').toLowerCase().includes('pdf')
}

function isImage(fileType: string | undefined): boolean {
  const type = (fileType || '').toLowerCase()
  return type.includes('image') || type.includes('png') || type.includes('jpg') || type.includes('jpeg')
}

function isSpreadsheet(fileType: string | undefined): boolean {
  const type = (fileType || '').toLowerCase()
  return type.includes('excel') || type.includes('spreadsheet')
}

function isTextLike(fileType: string | undefined): boolean {
  const type = (fileType || '').toLowerCase()
  return type.startsWith('text/') || type.includes('markdown') || type.includes('json')
}

function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'Unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getIngestionProgress(doc: Document): number {
  const raw = typeof doc.ingestion_progress === 'number' ? doc.ingestion_progress : (
    doc.status === 'completed' || doc.status === 'failed' ? 100 : 0
  )
  return Math.min(100, Math.max(0, Math.round(raw)))
}

function getIngestionMessage(doc: Document): string {
  if (doc.status === 'completed') return 'Ready'
  if (doc.status === 'failed') return doc.error_message || doc.ingestion_message || 'Import failed'
  return doc.ingestion_message || (doc.status === 'pending' ? 'Queued for processing' : 'Processing document')
}

function shouldShowIngestionProgress(doc: Document): boolean {
  return doc.status === 'pending' || doc.status === 'processing' || doc.status === 'failed'
}

function getFileTypeLabel(doc: Document): string {
  const type = (doc.file_type || '').toLowerCase()
  const filename = doc.filename || ''
  const ext = filename.includes('.') ? filename.split('.').pop()?.toUpperCase() : undefined
  if (type.includes('pdf')) return 'PDF'
  if (type.includes('word') || type.includes('document')) return ext || 'DOC'
  if (type.includes('excel') || type.includes('spreadsheet')) return ext || 'Sheet'
  if (type.includes('image')) return ext || 'Image'
  if (type.includes('markdown')) return 'Markdown'
  if (type.includes('text')) return 'Text'
  return ext || 'File'
}

function getDisplayTitle(doc: Document): string {
  const generatedTitle = typeof doc.metadata?.title === 'string' ? doc.metadata.title.trim() : ''
  return generatedTitle || doc.filename || 'Untitled document'
}

function ThumbnailPaper({ doc }: { doc: Document }) {
  const IconComponent = getFileTypeIcon(doc.file_type)
  const spreadsheet = isSpreadsheet(doc.file_type)

  return (
    <div className="relative flex h-[82%] w-[64%] max-w-[132px] flex-col overflow-hidden rounded-sm bg-white shadow-[0_8px_20px_-12px_rgba(15,23,42,0.5)] ring-1 ring-slate-200 dark:bg-slate-100 dark:ring-slate-300">
      <div className="flex h-7 items-center gap-1.5 border-b border-slate-100 px-2">
        <IconComponent className="h-3.5 w-3.5 text-slate-500" />
        <div className="h-1.5 w-14 rounded-full bg-slate-200" />
      </div>
      {spreadsheet ? (
        <div className="grid flex-1 grid-cols-4 gap-px p-2">
          {Array.from({ length: 28 }).map((_, index) => (
            <div
              key={index}
              className={`rounded-[1px] ${index % 5 === 0 ? 'bg-emerald-100' : 'bg-slate-100'}`}
            />
          ))}
        </div>
      ) : (
        <div className="flex-1 space-y-1.5 p-3">
          <div className="h-2 w-9/12 rounded-full bg-slate-300" />
          <div className="h-1.5 w-11/12 rounded-full bg-slate-200" />
          <div className="h-1.5 w-10/12 rounded-full bg-slate-200" />
          <div className="h-1.5 w-8/12 rounded-full bg-slate-200" />
          <div className="pt-2">
            <div className="h-1.5 w-11/12 rounded-full bg-slate-100" />
          </div>
          <div className="h-1.5 w-7/12 rounded-full bg-slate-100" />
        </div>
      )}
    </div>
  )
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (context.measureText(next).width <= maxWidth) {
      current = next
      continue
    }

    if (current) lines.push(current)

    if (context.measureText(word).width > maxWidth) {
      let fragment = ''
      for (const char of word) {
        const candidate = `${fragment}${char}`
        if (context.measureText(candidate).width <= maxWidth) {
          fragment = candidate
        } else {
          if (fragment) lines.push(fragment)
          fragment = char
        }
      }
      current = fragment
    } else {
      current = word
    }
  }

  if (current) lines.push(current)
  return lines
}

function renderTextThumbnail(canvas: HTMLCanvasElement, content: string, contentType: string) {
  const dpr = window.devicePixelRatio || 1
  const cssWidth = 150
  const cssHeight = 190
  const margin = 14
  const lineGap = 5
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not get canvas context')

  canvas.width = Math.floor(cssWidth * dpr)
  canvas.height = Math.floor(cssHeight * dpr)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`

  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, cssWidth, cssHeight)
  context.fillStyle = '#0f172a'
  context.textBaseline = 'top'

  const markdown = contentType.toLowerCase().includes('markdown')
  const maxWidth = cssWidth - margin * 2
  const rawLines = content.replace(/\t/g, '  ').split(/\r?\n/).slice(0, 42)
  let y = margin

  for (const rawLine of rawLines) {
    if (y > cssHeight - margin) break

    const trimmed = rawLine.trim()
    if (!trimmed) {
      y += 8
      continue
    }

    const heading = markdown ? trimmed.match(/^(#{1,3})\s+(.+)/) : null
    const bullet = markdown ? trimmed.replace(/^[-*]\s+/, '• ') : trimmed
    const displayText = heading ? heading[2] : bullet
    const fontSize = heading ? (heading[1].length === 1 ? 14 : 13) : 11
    const fontWeight = heading ? '700' : '400'
    const fontFamily = markdown && rawLine.startsWith('    ') ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'Geist, Arial, sans-serif'

    context.font = `${fontWeight} ${fontSize}px ${fontFamily}`
    context.fillStyle = heading ? '#111827' : '#334155'

    const wrapped = wrapCanvasText(context, displayText, maxWidth).slice(0, 3)
    for (const line of wrapped) {
      if (y > cssHeight - margin) break
      context.fillText(line, margin, y)
      y += fontSize + lineGap
    }
  }
}

function DocumentThumbnail({ doc }: { doc: Document }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  const [renderState, setRenderState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [isNearViewport, setIsNearViewport] = useState(false)
  const canRenderFile = doc.status === 'completed' && isNearViewport
  const imagePreview = canRenderFile && isImage(doc.file_type)
  const pdfPreview = canRenderFile && isPdf(doc.file_type) && doc.file_size <= PDF_THUMBNAIL_MAX_BYTES
  const textPreview = canRenderFile && isTextLike(doc.file_type) && doc.file_size <= TEXT_THUMBNAIL_MAX_BYTES

  useEffect(() => {
    const node = containerRef.current
    if (!node) return

    if (typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setIsNearViewport(true)
        observer.disconnect()
      },
      { rootMargin: '320px' }
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current

    setThumbnailUrl(null)
    setRenderState('idle')
    if (canvas) {
      const context = canvas.getContext('2d')
      context?.clearRect(0, 0, canvas.width, canvas.height)
    }

    if (!imagePreview && !pdfPreview && !textPreview) return

    setRenderState('loading')

    if (imagePreview) {
      getDocumentDownloadUrl(doc.id)
        .then(({ url }) => {
          if (!cancelled) {
            setThumbnailUrl(url)
            setRenderState('ready')
          }
        })
        .catch(() => {
          if (!cancelled) setRenderState('failed')
        })

      return () => {
        cancelled = true
      }
    }

    ;(async () => {
      if (!canvas) {
        setRenderState('failed')
        return
      }

      try {
        const { url } = await getDocumentDownloadUrl(doc.id)
        if (cancelled) return

        if (textPreview) {
          const response = await fetch(url)
          if (!response.ok) throw new Error(`Failed to load text file (HTTP ${response.status})`)
          const text = await response.text()
          if (cancelled) return
          renderTextThumbnail(canvas, text, doc.file_type)
          if (!cancelled) setRenderState('ready')
          return
        }

        await ensurePdfWorker()
        if (cancelled) return

        const pdfjs = await import('pdfjs-dist')
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to load PDF (HTTP ${response.status})`)

        const buffer = await response.arrayBuffer()
        if (cancelled) return

        const pdf = await pdfjs.getDocument({ data: buffer }).promise
        try {
          const page = await pdf.getPage(1)
          try {
            const baseViewport = page.getViewport({ scale: 1 })
            const cssScale = Math.min(
              150 / (baseViewport.width * THUMBNAIL_CROP_RATIO),
              190 / (baseViewport.height * THUMBNAIL_CROP_RATIO),
              1.1
            )
            const viewport = page.getViewport({ scale: cssScale })
            const dpr = window.devicePixelRatio || 1
            const cropWidth = viewport.width * THUMBNAIL_CROP_RATIO
            const cropHeight = viewport.height * THUMBNAIL_CROP_RATIO
            const insetX = viewport.width * PDF_THUMBNAIL_INSET_X_RATIO
            const insetY = viewport.height * PDF_THUMBNAIL_INSET_Y_RATIO

            canvas.width = Math.floor(cropWidth * dpr)
            canvas.height = Math.floor(cropHeight * dpr)
            canvas.style.width = `${cropWidth}px`
            canvas.style.height = `${cropHeight}px`

            const context = canvas.getContext('2d')
            if (!context) throw new Error('Could not get canvas context')
            context.scale(dpr, dpr)
            context.translate(-insetX, -insetY)

            await page.render({ canvasContext: context, viewport }).promise
            if (!cancelled) setRenderState('ready')
          } finally {
            page.cleanup()
          }
        } finally {
          pdf.destroy()
        }
      } catch {
        if (!cancelled) setRenderState('failed')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [doc.file_size, doc.file_type, doc.id, doc.status, imagePreview, pdfPreview, textPreview])

  const canvasPreview = pdfPreview || textPreview
  const showFallback = renderState !== 'ready' || (!thumbnailUrl && !canvasPreview)

  return (
    <div
      ref={containerRef}
      className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md bg-muted/40 transition-colors group-hover:bg-muted/60"
    >
      {thumbnailUrl && imagePreview && renderState === 'ready' && (
        <img
          src={thumbnailUrl}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          draggable={false}
          onError={() => setRenderState('failed')}
        />
      )}

      {canvasPreview && (
        <canvas
          ref={canvasRef}
          className={`max-h-[86%] max-w-[74%] rounded-sm bg-white shadow-[0_10px_24px_-14px_rgba(15,23,42,0.65)] ${
            renderState === 'ready' ? 'block' : 'hidden'
          }`}
          aria-hidden="true"
        />
      )}

      {showFallback && <ThumbnailPaper doc={doc} />}

      {renderState === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/35 dark:bg-background/25">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  )
}


export function DocumentList({
  folders = [],
  documents = [],
  loading,
  hasMore,
  currentFolderId,
  searchValue,
  searchActive,
  onSearchChange,
  onLoadMore,
  onSelectFolder,
  onSelectDocument,
  onDeleteDocument,
  onRetryDocument,
  onBulkDelete,
  onBulkMove,
  onAddFiles,
}: DocumentListProps) {
  const { user } = useAuth()
  const [sortBy, setSortBy] = useState<SortOption>('uploaded_desc')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [fileTypeFilter, setFileTypeFilter] = useState<FileTypeFilter>('all')
  const [retryingIds, setRetryingIds] = useState<Set<string>>(() => new Set())

  // Multi-select state for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const lastSelectedIndexRef = useRef<number | null>(null)

  // Intersection observer for infinite scroll
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore || loading) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onLoadMore()
        }
      },
      { threshold: 0.1 }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loading, onLoadMore])

  // Apply sorting and filtering
  const filteredAndSortedDocs = useMemo(() => {
    let filtered = documents

    // Filter by status
    if (statusFilter !== 'all') {
      filtered = filtered.filter(doc => doc.status === statusFilter)
    }

    // Filter by file type
    if (fileTypeFilter !== 'all') {
      filtered = filtered.filter(doc => getFileTypeCategory(doc.file_type) === fileTypeFilter)
    }

    // Sort — skipped while searching so the backend relevance order is preserved.
    const sorted = [...filtered]
    if (!searchActive) {
      switch (sortBy) {
        case 'uploaded_desc':
          sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          break
        case 'name_asc':
          sorted.sort((a, b) => a.filename.localeCompare(b.filename))
          break
        case 'name_desc':
          sorted.sort((a, b) => b.filename.localeCompare(a.filename))
          break
      }
    }

    return sorted
  }, [documents, sortBy, statusFilter, fileTypeFilter, searchActive])

  // Only the owner can bulk delete/move, so only owned + currently-visible docs
  // are selectable. Keep this in document order for shift-range selection.
  const selectableIds = useMemo(
    () => filteredAndSortedDocs.filter(doc => doc.user_id === user?.id).map(doc => doc.id),
    [filteredAndSortedDocs, user?.id],
  )

  // Drop any selected ids that are no longer visible (folder change, filter change,
  // or realtime delete) so bulk actions only ever touch what the user can see.
  useEffect(() => {
    setSelectedIds(prev => {
      if (prev.size === 0) return prev
      const visible = new Set(filteredAndSortedDocs.map(doc => doc.id))
      let changed = false
      const next = new Set<string>()
      prev.forEach(id => {
        if (visible.has(id)) next.add(id)
        else changed = true
      })
      return changed ? next : prev
    })
  }, [filteredAndSortedDocs])

  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.has(id))

  const handleToggleSelect = useCallback((docId: string, index: number, shiftKey: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      const lastIndex = lastSelectedIndexRef.current
      if (shiftKey && lastIndex !== null) {
        // Select the contiguous range of selectable docs between the two clicks.
        const [start, end] = lastIndex < index ? [lastIndex, index] : [index, lastIndex]
        for (let i = start; i <= end; i++) {
          const doc = filteredAndSortedDocs[i]
          if (doc && doc.user_id === user?.id) next.add(doc.id)
        }
      } else if (next.has(docId)) {
        next.delete(docId)
      } else {
        next.add(docId)
      }
      return next
    })
    lastSelectedIndexRef.current = index
  }, [filteredAndSortedDocs, user?.id])

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds(prev => (
      selectableIds.length > 0 && selectableIds.every(id => prev.has(id))
        ? new Set()
        : new Set(selectableIds)
    ))
  }, [selectableIds])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    lastSelectedIndexRef.current = null
  }, [])

  const handleBulkDelete = useCallback(async () => {
    await onBulkDelete([...selectedIds])
    clearSelection()
  }, [onBulkDelete, selectedIds, clearSelection])

  const handleBulkMove = useCallback(async (folderId: string | null) => {
    await onBulkMove([...selectedIds], folderId)
    clearSelection()
  }, [onBulkMove, selectedIds, clearSelection])

  const handleRetryDocument = useCallback(async (doc: Document) => {
    setRetryingIds(prev => new Set(prev).add(doc.id))
    try {
      await onRetryDocument(doc)
    } catch (error) {
      console.error('Failed to retry document:', error)
    } finally {
      setRetryingIds(prev => {
        const next = new Set(prev)
        next.delete(doc.id)
        return next
      })
    }
  }, [onRetryDocument])

  const selectionActive = selectedIds.size > 0

  if (loading && documents.length === 0 && folders.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  const hasFilters = statusFilter !== 'all' || fileTypeFilter !== 'all'
  const hasDocuments = documents.length > 0

  return (
    <div className="space-y-7">
      {/* Bulk actions bar — appears once one or more documents are selected */}
      {selectionActive && (
        <DocumentBulkActionsBar
          selectedCount={selectedIds.size}
          selectableCount={selectableIds.length}
          allSelected={allSelected}
          currentFolderId={currentFolderId}
          onToggleSelectAll={handleToggleSelectAll}
          onClear={clearSelection}
          onDelete={handleBulkDelete}
          onMove={handleBulkMove}
        />
      )}

      {/* Folders section — hidden during a global search (results span all folders) */}
      {folders.length > 0 && !searchActive && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {folders.map((folder) => (
            <button
              type="button"
              key={folder.id}
              data-testid={`folder-card-${folder.id}`}
              onClick={() => onSelectFolder(folder.id, folder.name)}
              className="flex h-12 items-center gap-3 rounded-md border border-transparent bg-muted/60 px-3 text-left transition-colors hover:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
            >
              <FolderIcon className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-sm font-medium text-foreground" title={folder.name}>
                {folder.name}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Controls — the search box is always available so you can search from anywhere (including
          an empty folder); the Sort/Status/Type filters appear once there is something to filter
          (documents present, a filter applied, or an active search). */}
      <div className="flex flex-wrap items-center gap-3">
        {(hasDocuments || hasFilters || searchActive) && (
          <>
            {/* Sort — replaced by a relevance hint while searching (results are relevance-ranked) */}
            {searchActive ? (
              <span className="text-sm text-muted-foreground">Sorted by relevance</span>
            ) : (
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-muted-foreground">Sort:</label>
                <select
                  value={sortBy}
                  onChange={e => setSortBy(e.target.value as SortOption)}
                  className="px-3 py-1.5 text-sm border border-border/50 rounded-lg bg-surface-2 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors"
                >
                  <option value="uploaded_desc">Date uploaded</option>
                  <option value="name_asc">Name A-Z</option>
                  <option value="name_desc">Name Z-A</option>
                </select>
              </div>
            )}

            {/* Status Filter */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-muted-foreground">Status:</label>
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as StatusFilter)}
                className="px-3 py-1.5 text-sm border border-border/50 rounded-lg bg-surface-2 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors"
              >
                <option value="all">All</option>
                <option value="pending">Pending</option>
                <option value="completed">Completed</option>
                <option value="processing">Processing</option>
                <option value="failed">Failed</option>
              </select>
            </div>

            {/* File Type Filter */}
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-muted-foreground">Type:</label>
              <select
                value={fileTypeFilter}
                onChange={e => setFileTypeFilter(e.target.value as FileTypeFilter)}
                className="px-3 py-1.5 text-sm border border-border/50 rounded-lg bg-surface-2 focus:outline-none focus:ring-2 focus:ring-ring/20 transition-colors"
              >
                <option value="all">All</option>
                <option value="pdf">PDF</option>
                <option value="word">Word</option>
                <option value="excel">Excel</option>
                <option value="image">Image</option>
                <option value="text">Text</option>
              </select>
            </div>

            {/* Reset Filters */}
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStatusFilter('all')
                  setFileTypeFilter('all')
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                Clear filters
              </Button>
            )}
          </>
        )}

        {/* Search — always available; right of the filters, growing to the container's right edge */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
          <Input
            type="text"
            value={searchValue}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search documents…"
            aria-label="Search documents"
            className="pl-9 pr-8 h-9"
          />
          {searchValue && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-accent/50 transition-colors"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Documents Grid */}
      {filteredAndSortedDocs.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-5 gap-y-6 items-start sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {filteredAndSortedDocs.map((doc, index) => {
            const generatedTitle = typeof doc.metadata?.title === 'string' ? doc.metadata.title : undefined
            const showFilename = !!generatedTitle && generatedTitle !== doc.filename
            const displayTitle = getDisplayTitle(doc)
            const isOwned = doc.user_id === user?.id
            const isSelected = selectedIds.has(doc.id)
            const showProgress = shouldShowIngestionProgress(doc)
            const progress = getIngestionProgress(doc)
            const progressMessage = getIngestionMessage(doc)
            const isRetrying = retryingIds.has(doc.id)
            const canRetry = isOwned && doc.status === 'failed'
            return (
              <DocumentContextMenu
                key={doc.id}
                document={doc}
                onDelete={onDeleteDocument}
              >
                <div className="group relative">
                  {isOwned && (
                    <div
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-label={`Select ${displayTitle}`}
                      tabIndex={0}
                      data-testid={`document-select-${doc.id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        event.preventDefault()
                        handleToggleSelect(doc.id, index, event.shiftKey)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === ' ' || event.key === 'Enter') {
                          event.stopPropagation()
                          event.preventDefault()
                          handleToggleSelect(doc.id, index, event.shiftKey)
                        }
                      }}
                      className={cn(
                        'absolute left-2 top-2 z-20 cursor-pointer rounded-md bg-background/85 p-1 shadow-sm ring-1 ring-border/60 backdrop-blur-sm transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                        isSelected || selectionActive
                          ? 'opacity-100'
                          : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                      )}
                    >
                      <Checkbox checked={isSelected} className="pointer-events-none" tabIndex={-1} aria-hidden />
                    </div>
                  )}
                  <button
                    type="button"
                    data-testid={`document-card-${doc.id}`}
                    onClick={() => doc.status === 'completed' && onSelectDocument(doc)}
                    aria-disabled={doc.status !== 'completed'}
                    className={`relative w-full rounded-md p-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 ${
                      doc.status === 'completed' ? 'cursor-pointer hover:bg-muted/45' : 'cursor-default opacity-90'
                    } ${isSelected ? 'bg-primary/5 ring-2 ring-primary/40' : ''}`}
                  >
                    <StatusIcon status={doc.status} />
                    <DocumentThumbnail doc={doc} />
                    <div className="min-w-0 space-y-1 px-1 pb-1 pt-2">
                      <p className="truncate text-sm font-medium text-foreground" title={displayTitle}>
                        {displayTitle}
                      </p>
                      {showFilename && (
                        <p className="truncate text-xs text-muted-foreground" title={doc.filename}>
                          {doc.filename}
                        </p>
                      )}
                      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="shrink-0">{getFileTypeLabel(doc)}</span>
                        <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
                        <span className="truncate">{formatFileSize(doc.file_size)}</span>
                      </div>
                      {showProgress && (
                        <div
                          className="space-y-1 pt-1"
                          data-testid={`document-progress-${doc.id}`}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-2 text-label leading-tight">
                            <span
                              className={cn(
                                'min-w-0 truncate',
                                doc.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                              )}
                              title={progressMessage}
                            >
                              {progressMessage}
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {progress}%
                            </span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn(
                                'h-full rounded-full transition-all duration-500',
                                doc.status === 'failed'
                                  ? 'bg-destructive'
                                  : doc.status === 'pending'
                                    ? 'bg-clay'
                                    : 'bg-primary',
                              )}
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </button>
                  {canRetry && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      data-testid={`document-retry-${doc.id}`}
                      title="Retry ingestion"
                      aria-label={`Retry ingestion for ${displayTitle}`}
                      disabled={isRetrying}
                      onClick={(event) => {
                        event.stopPropagation()
                        event.preventDefault()
                        void handleRetryDocument(doc)
                      }}
                      className="absolute right-3 top-12 z-20 h-7 w-7 rounded-md bg-background/90 shadow-sm ring-1 ring-border/60 backdrop-blur-sm transition-opacity hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/40"
                    >
                      <RefreshCcw className={cn('h-3.5 w-3.5', isRetrying && 'animate-spin')} aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </DocumentContextMenu>
            )
          })}
        </div>
      ) : searchActive ? (
        !loading ? (
          <p className="text-sm text-muted-foreground text-center py-8">
            No documents match "{searchValue}".
          </p>
        ) : null
      ) : hasFilters ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          No documents match the current filters.
        </p>
      ) : !loading ? (
        <EmptyFolderState onAddFiles={onAddFiles} />
      ) : null}

      {/* Infinite Scroll Sentinel */}
      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              Loading more…
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Scroll for more…</p>
          )}
        </div>
      )}

    </div>
  )
}
