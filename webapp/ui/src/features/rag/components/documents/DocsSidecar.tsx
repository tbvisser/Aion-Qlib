import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Download,
  Eye,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Info,
  Layers3,
  Loader2,
  Maximize2,
  Minimize2,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DocumentStructureNav } from '@/features/rag/components/documents/DocumentStructureNav'
import { DocumentTextView } from '@/features/rag/components/documents/DocumentTextView'
import { MetadataPanel } from '@/features/rag/components/documents/MetadataPanel'
import { PreviewBody } from '@/features/rag/components/shared/PreviewBody'
import { useAuth } from '@/hooks/useAuth'
import {
  deleteDocument,
  getDocumentChunks,
  getDocumentDownloadUrl,
  getDocumentRender,
  type ChunkInfo,
  type DocumentRender,
  type DocumentStructureNode,
} from '@/features/rag/lib/api'
import type { Document } from '@/features/rag/types'

type Tab = 'preview' | 'text' | 'metadata' | 'chunks'

interface DocsSidecarProps {
  document: Document
  onClose: () => void
  onDeleted: (id: string) => void
}

function getFileTypeIcon(fileType: string | undefined) {
  const type = (fileType || '').toLowerCase()
  if (type.includes('pdf')) return FileType
  if (type.includes('word') || type.includes('document')) return FileText
  if (type.includes('excel') || type.includes('spreadsheet')) return FileSpreadsheet
  if (type.includes('image') || type.includes('png') || type.includes('jpg') || type.includes('jpeg')) return FileImage
  if (type.includes('text') || type.includes('markdown')) return FileText
  return FileIcon
}

function StatusBadge({ status }: { status: Document['status'] }) {
  const styles: Record<Document['status'], string> = {
    pending: 'bg-clay/15 text-clay border-clay/30',
    processing: 'bg-muted text-muted-foreground border-border/50',
    completed: 'bg-primary/15 text-primary border-primary/30',
    failed: 'bg-destructive/15 text-destructive border-destructive/30',
  }
  const labels: Record<Document['status'], string> = {
    pending: 'Pending',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
  }
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[status]}`}>
      {labels[status]}
    </span>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DocsSidecar({ document: doc, onClose, onDeleted }: DocsSidecarProps) {
  const { user } = useAuth()
  const canDelete = doc.user_id === user?.id
  const [activeTab, setActiveTab] = useState<Tab>('preview')
  const [isExpanded, setIsExpanded] = useState(false)
  const [renderData, setRenderData] = useState<DocumentRender | null>(null)
  const [renderLoading, setRenderLoading] = useState(false)
  const [targetPage, setTargetPage] = useState<number | null>(null)
  const [targetNode, setTargetNode] = useState<DocumentStructureNode | null>(null)
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [chunks, setChunks] = useState<ChunkInfo[]>([])
  const [chunksLoading, setChunksLoading] = useState(false)
  const [expandedChunk, setExpandedChunk] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setActiveTab('preview')
    setIsExpanded(false)
    setTargetPage(null)
    setTargetNode(null)
    setActiveNodeId(null)
  }, [doc.id])

  useEffect(() => {
    let cancelled = false
    setRenderData(null)
    setRenderLoading(true)

    getDocumentRender(doc.id)
      .then(data => { if (!cancelled) setRenderData(data) })
      .catch(() => { if (!cancelled) setRenderData(null) })
      .finally(() => { if (!cancelled) setRenderLoading(false) })

    return () => { cancelled = true }
  }, [doc.id])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    if (confirmDeleteOpen) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose, confirmDeleteOpen])

  useEffect(() => {
    if (activeTab !== 'chunks') return
    const controller = new AbortController()
    setChunksLoading(true)
    setExpandedChunk(null)
    getDocumentChunks(doc.id)
      .then(data => { if (!controller.signal.aborted) setChunks(data) })
      .catch(() => { if (!controller.signal.aborted) setChunks([]) })
      .finally(() => { if (!controller.signal.aborted) setChunksLoading(false) })
    return () => controller.abort()
  }, [doc.id, activeTab])

  const handleDownload = useCallback(async () => {
    const { url } = await getDocumentDownloadUrl(doc.id)
    window.open(url, '_blank')
  }, [doc.id])

  const fetchUrl = useCallback(async () => {
    const { url } = await getDocumentDownloadUrl(doc.id)
    return url
  }, [doc.id])

  const fetchTextContent = useCallback(async () => {
    const { url } = await getDocumentDownloadUrl(doc.id)
    const resp = await fetch(url)
    if (!resp.ok) throw new Error('Failed to fetch file content')
    return resp.text()
  }, [doc.id])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteDocument(doc.id)
      setConfirmDeleteOpen(false)
      onDeleted(doc.id)
    } catch (err) {
      console.error('Failed to delete document:', err)
      setDeleting(false)
    }
  }, [doc.id, onDeleted])

  const handleStructureSelect = useCallback((node: DocumentStructureNode) => {
    setActiveNodeId(node.id)
    setTargetNode({ ...node })
    if (typeof node.page_no === 'number') {
      setTargetPage(node.page_no)
    } else {
      setTargetPage(null)
    }
    if (activeTab !== 'text') {
      setActiveTab('preview')
    }
  }, [activeTab])

  const IconComponent = useMemo(() => getFileTypeIcon(doc.file_type), [doc.file_type])
  const title = doc.metadata?.title as string | undefined
  const hasStructureNodes = (renderData?.structure?.nodes?.length ?? 0) > 0
  const tabs = useMemo(() => ([
    { id: 'preview' as const, label: 'Preview', icon: Eye },
    { id: 'text' as const, label: 'Text', icon: FileText },
    { id: 'metadata' as const, label: 'Metadata', icon: Info },
    { id: 'chunks' as const, label: 'Chunks', icon: Layers3 },
  ]), [])

  return (
    <div
      ref={ref}
      data-testid="docs-sidecar"
      data-expanded={isExpanded ? 'true' : 'false'}
      className={`absolute right-0 top-0 z-30 flex h-full w-full flex-col border-l border-border/50 bg-card shadow-xl transition-[width] duration-200 ${isExpanded ? 'md:w-[72%]' : 'md:w-1/2'}`}
    >
      <div className="px-6 pt-5 pb-4 border-b border-border/50 shrink-0 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-muted/50 shrink-0">
              <IconComponent className="w-5 h-5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold truncate" title={title || doc.filename}>
                {title || doc.filename}
              </h2>
              {title && (
                <p className="text-xs text-muted-foreground truncate" title={doc.filename}>
                  {doc.filename}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="hidden h-8 w-8 md:inline-flex"
              onClick={() => setIsExpanded(prev => !prev)}
              title={isExpanded ? 'Collapse' : 'Expand'}
              aria-label={isExpanded ? 'Collapse sidecar' : 'Expand sidecar'}
              data-testid="docs-sidecar-expand-toggle"
            >
              {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-11 w-11 lg:h-8 lg:w-8" onClick={handleDownload} title="Download" aria-label="Download" data-testid="docs-sidecar-download">
              <Download className="h-4 w-4" />
            </Button>
            {canDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 text-muted-foreground hover:text-destructive lg:h-8 lg:w-8"
                onClick={() => setConfirmDeleteOpen(true)}
                disabled={deleting}
                title="Delete"
                aria-label="Delete document"
                data-testid="docs-sidecar-delete"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-11 w-11 lg:h-8 lg:w-8" onClick={onClose} title="Close" aria-label="Close" data-testid="docs-sidecar-close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <StatusBadge status={doc.status} />
          <span className="text-xs text-muted-foreground">{formatFileSize(doc.file_size)}</span>
          <span className="text-xs text-muted-foreground">{doc.chunk_count} chunks</span>
          <span className="text-xs text-muted-foreground">{new Date(doc.created_at).toLocaleDateString()}</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {hasStructureNodes && (
          <DocumentStructureNav
            structure={renderData?.structure ?? null}
            loading={renderLoading}
            activeNodeId={activeNodeId}
            onSelectNode={handleStructureSelect}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <TooltipProvider>
            <div className="flex h-12 items-center gap-1 border-b border-border/50 px-4">
              {tabs.map(tab => {
                const Icon = tab.icon
                const active = activeTab === tab.id
                return (
                  <Tooltip key={tab.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        data-testid={`docs-sidecar-tab-${tab.id}`}
                        data-active={active ? 'true' : 'false'}
                        onClick={() => setActiveTab(tab.id)}
                        className={`flex h-10 w-10 items-center justify-center rounded-md transition-colors lg:h-8 lg:w-8 ${
                          active
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                        }`}
                        aria-label={tab.label}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{tab.label}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          </TooltipProvider>

          <div
            className={`min-h-0 flex-1 overflow-x-auto p-6 [scrollbar-gutter:stable] ${
              activeTab === 'preview' ? 'overflow-y-scroll' : 'overflow-y-auto'
            }`}
            data-testid="docs-sidecar-content"
          >
            {activeTab === 'preview' && (
              <PreviewBody
                file={{ name: doc.filename, sizeBytes: doc.file_size, contentType: doc.file_type }}
                fetchUrl={fetchUrl}
                fetchTextContent={fetchTextContent}
                viewMode="rendered"
                onDownload={handleDownload}
                targetPage={targetPage}
                targetNode={targetNode}
              />
            )}
            {activeTab === 'text' && (
              renderLoading ? (
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <DocumentTextView
                  pages={renderData?.pages ?? []}
                  markdownFallback={renderData?.markdown}
                  targetPage={targetPage}
                  targetNode={targetNode}
                />
              )
            )}
            {activeTab === 'metadata' && (
              <MetadataPanel metadata={doc.metadata as Record<string, unknown> | null} />
            )}
            {activeTab === 'chunks' && (
              chunksLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : chunks.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No chunks available</p>
              ) : (
                <div className="space-y-2">
                  {chunks.map(chunk => {
                    const meta = chunk.metadata as Record<string, unknown> | null
                    const isChunkExpanded = expandedChunk === chunk.chunk_index
                    return (
                      <div key={chunk.id} className="border border-border/50 rounded-lg overflow-hidden">
                        <button
                          onClick={() => setExpandedChunk(isChunkExpanded ? null : chunk.chunk_index)}
                          className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                        >
                          <span className="shrink-0 w-8 h-8 rounded-md bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                            {chunk.chunk_index}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {(meta?.cascading_path as string) || `Chunk ${chunk.chunk_index}`}
                            </p>
                            <div className="flex gap-3 text-xs text-muted-foreground">
                              <span>{chunk.content.length} chars</span>
                              {Array.isArray(meta?.childRange) && (
                                <span>child: [{(meta.childRange as number[]).join('-')}]</span>
                              )}
                              {Array.isArray(meta?.parentRange) && (
                                <span>parent: [{(meta.parentRange as number[]).join('-')}]</span>
                              )}
                            </div>
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0">{isChunkExpanded ? 'v' : '>'}</span>
                        </button>
                        {isChunkExpanded && (
                          <div className="border-t border-border/50">
                            <pre className="p-3 text-xs font-mono whitespace-pre-wrap bg-muted/20 max-h-64 overflow-auto">
                              {chunk.content}
                            </pre>
                            {meta && Object.keys(meta).length > 0 && (
                              <div className="p-3 border-t border-border/30 bg-muted/10">
                                <p className="text-xs font-medium text-muted-foreground mb-1">Metadata</p>
                                <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground">
                                  {JSON.stringify(meta, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{doc.filename}" and all of its chunks. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete() }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
