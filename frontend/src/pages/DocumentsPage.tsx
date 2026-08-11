import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import {
  DOCUMENT_UPLOAD_FORMAT_LABEL,
  useDocumentUpload,
} from '@/hooks/useDocumentUpload'
import { DocumentUpload } from '@/components/documents/DocumentUpload'
import { DocumentList } from '@/components/documents/DocumentList'
import { DocsSidecar } from '@/components/documents/DocsSidecar'
import { FolderBreadcrumbs } from '@/components/documents/FolderBreadcrumbs'
import { FolderTree } from '@/components/folders/FolderTree'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { MobileTopBar } from '@/components/layout/MobileTopBar'
import { bulkDeleteDocuments, bulkMoveDocuments, deleteDocument, listFolders, listDocuments, retryDocument, searchDocuments } from '@/lib/api'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { isFileDrag } from '@/hooks/useFileDrop'
import { supabase } from '@/lib/supabase'
import type { Document, Folder } from '@/types'
import { FileUp, Info, Upload, X } from 'lucide-react'

function hasDocumentIdentity(doc: Partial<Document>): doc is Document {
  return (
    typeof doc.id === 'string' &&
    typeof doc.user_id === 'string' &&
    typeof doc.filename === 'string' &&
    typeof doc.file_type === 'string' &&
    typeof doc.file_size === 'number' &&
    typeof doc.storage_path === 'string' &&
    typeof doc.status === 'string' &&
    typeof doc.created_at === 'string' &&
    typeof doc.updated_at === 'string'
  )
}

function mergeDocumentUpdate(existing: Document, update: Partial<Document>): Document {
  return {
    ...existing,
    ...update,
    id: existing.id,
    filename: update.filename ?? existing.filename,
    file_type: update.file_type ?? existing.file_type,
    file_size: update.file_size ?? existing.file_size,
    storage_path: update.storage_path ?? existing.storage_path,
    user_id: update.user_id ?? existing.user_id,
    folder_id: update.folder_id ?? existing.folder_id,
    created_at: update.created_at ?? existing.created_at,
    updated_at: update.updated_at ?? existing.updated_at,
  }
}

export function DocumentsPage() {
  const { folderId: urlFolderId } = useParams<{ folderId?: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const selectedFolderId = urlFolderId ?? null
  const [selectedFolderName, setSelectedFolderName] = useState<string | null>(null)
  const [showUploadModal, setShowUploadModal] = useState(false)
  const [showPageDropOverlay, setShowPageDropOverlay] = useState(false)
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null)
  const pageDropCloseTimerRef = useRef<number | null>(null)

  // State for folders and documents with pagination
  const [folders, setFolders] = useState<Folder[]>([])
  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)
  const LIMIT = 50

  // Global document search (filename + hybrid content). When active, the list becomes a ranked
  // result set spanning all folders rather than the current folder's contents.
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedSearch = useDebouncedValue(searchQuery, 250)
  const searchActive = debouncedSearch.trim().length > 0
  const searchActiveRef = useRef(searchActive)
  useEffect(() => {
    searchActiveRef.current = searchActive
  }, [searchActive])

  const matchesSelectedFolder = useCallback((doc: Document) => {
    if (selectedFolderId === null) return doc.folder_id === null
    return doc.folder_id === selectedFolderId
  }, [selectedFolderId])

  // Clear folder name when URL param changes (breadcrumbs will re-fetch)
  useEffect(() => {
    setSelectedFolderName(null)
  }, [urlFolderId])

  // Load documents when the folder, user, or (debounced) search term changes. A cancelled flag
  // discards stale responses when the term changes faster than requests resolve.
  useEffect(() => {
    if (!user) return
    let cancelled = false

    const loadData = async () => {
      setSelectedDocument(null)
      setLoading(true)
      try {
        if (searchActive) {
          // Search mode: global ranked results, independent of the current folder.
          const docsResponse = await searchDocuments({ query: debouncedSearch, limit: LIMIT })
          if (cancelled) return
          setDocuments(docsResponse?.documents || [])
          setHasMore(false)
          setOffset(0)
        } else {
          // Browse mode: child folders + first page of documents.
          // null = root level folders, string = subfolder
          const foldersData = await listFolders(selectedFolderId || undefined)
          const docsResponse = await listDocuments({
            folderId: selectedFolderId,
            offset: 0,
            limit: LIMIT
          })
          if (cancelled) return
          setFolders(foldersData || [])
          setDocuments(docsResponse?.documents || [])
          setHasMore(docsResponse?.has_more ?? false)
          setOffset(LIMIT)
        }
      } catch (error) {
        if (!cancelled) console.error('Failed to load data:', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadData()
    return () => {
      cancelled = true
    }
  }, [selectedFolderId, user, debouncedSearch, searchActive])

  // Keep ingestion status live while the documents page stays mounted.
  useEffect(() => {
    if (!user) return

    const channel = supabase
      .channel(`documents-page-${user.id}-${selectedFolderId ?? 'knowledgebase'}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'documents',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const changedDoc = payload.new as Partial<Document>
            if (typeof changedDoc.id !== 'string') return

            if (searchActiveRef.current) {
              // During a global search the list is a ranked result set, not a folder view: only
              // refresh rows already on screen (e.g. live ingestion progress); never add rows or
              // drop them based on folder membership.
              setDocuments(prev => {
                const existingDoc = prev.find(doc => doc.id === changedDoc.id)
                if (!existingDoc) return prev
                return prev.map(doc => (
                  doc.id === changedDoc.id ? mergeDocumentUpdate(existingDoc, changedDoc) : doc
                ))
              })
              setSelectedDocument(prev => {
                if (!prev || prev.id !== changedDoc.id) return prev
                return mergeDocumentUpdate(prev, changedDoc)
              })
              return
            }

            setDocuments(prev => {
              const existingDoc = prev.find(doc => doc.id === changedDoc.id)
              const mergedDoc = existingDoc
                ? mergeDocumentUpdate(existingDoc, changedDoc)
                : hasDocumentIdentity(changedDoc)
                  ? changedDoc
                  : null

              if (!mergedDoc) return prev

              const belongsHere = matchesSelectedFolder(mergedDoc)
              const exists = !!existingDoc

              if (!belongsHere) {
                return exists ? prev.filter(doc => doc.id !== changedDoc.id) : prev
              }

              if (exists) {
                return prev.map(doc => doc.id === changedDoc.id ? mergedDoc : doc)
              }

              return [mergedDoc, ...prev]
            })

            setSelectedDocument(prev => {
              if (!prev || prev.id !== changedDoc.id) return prev
              return mergeDocumentUpdate(prev, changedDoc)
            })
            return
          }

          if (payload.eventType === 'DELETE') {
            const deletedId = (payload.old as { id?: string }).id
            if (!deletedId) return

            setDocuments(prev => prev.filter(doc => doc.id !== deletedId))
            setSelectedDocument(prev => prev?.id === deletedId ? null : prev)
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [matchesSelectedFolder, selectedFolderId, user])

  // Load more documents (for infinite scroll)
  const loadMoreDocuments = async () => {
    if (loading || !hasMore) return

    setLoading(true)
    try {
      const response = await listDocuments({
        folderId: selectedFolderId,
        offset,
        limit: LIMIT
      })

      // Dedupe by id: Realtime INSERTs prepend freshly-uploaded docs while the
      // offset-based page can re-fetch those same rows (an insert shifts every
      // row down by one), so a naive append produces duplicate React keys.
      setDocuments(prev => {
        const seen = new Set(prev.map(doc => doc.id))
        const incoming = (response?.documents || []).filter(doc => !seen.has(doc.id))
        return incoming.length ? [...prev, ...incoming] : prev
      })
      setHasMore(response?.has_more ?? false)
      setOffset(prev => prev + LIMIT)
    } catch (error) {
      console.error('Failed to load more documents:', error)
    } finally {
      setLoading(false)
    }
  }

  // Refetch after upload
  const refetch = useCallback(async () => {
    if (!user) return

    try {
      const [foldersData, docsResponse] = await Promise.all([
        listFolders(selectedFolderId || undefined),
        listDocuments({
          folderId: selectedFolderId,
          offset: 0,
          limit: LIMIT
        })
      ])

      setFolders(foldersData || [])
      setDocuments(docsResponse?.documents || [])
      setHasMore(docsResponse?.has_more ?? false)
      setOffset(LIMIT)
    } catch (error) {
      console.error('Failed to refetch data:', error)
    }
  }, [selectedFolderId, user])

  const clearPageDropCloseTimer = useCallback(() => {
    if (pageDropCloseTimerRef.current !== null) {
      window.clearTimeout(pageDropCloseTimerRef.current)
      pageDropCloseTimerRef.current = null
    }
  }, [])

  const schedulePageDropClose = useCallback(() => {
    clearPageDropCloseTimer()
    pageDropCloseTimerRef.current = window.setTimeout(() => {
      setShowPageDropOverlay(false)
      pageDropCloseTimerRef.current = null
    }, 2500)
  }, [clearPageDropCloseTimer])

  const handlePageDropUploadComplete = useCallback(async () => {
    clearPageDropCloseTimer()
    await refetch()
    setShowPageDropOverlay(false)
  }, [clearPageDropCloseTimer, refetch])

  const handlePageDropUploadSkipped = useCallback(() => {
    schedulePageDropClose()
  }, [schedulePageDropClose])

  const {
    uploading: pageDropUploading,
    error: pageDropError,
    feedback: pageDropFeedback,
    handleUpload: handlePageDropUpload,
    reset: resetPageDropUpload,
  } = useDocumentUpload({
    folderId: selectedFolderId ?? null,
    onUploadComplete: handlePageDropUploadComplete,
    onSkipped: handlePageDropUploadSkipped,
  })

  useEffect(() => {
    return () => clearPageDropCloseTimer()
  }, [clearPageDropCloseTimer])

  useEffect(() => {
    if (!showPageDropOverlay) {
      resetPageDropUpload()
    }
  }, [resetPageDropUpload, showPageDropOverlay])

  useEffect(() => {
    if (!showUploadModal) return
    setShowPageDropOverlay(false)
    resetPageDropUpload()
  }, [resetPageDropUpload, showUploadModal])

  const showDocumentDropOverlay = useCallback(() => {
    clearPageDropCloseTimer()
    setShowPageDropOverlay(true)
  }, [clearPageDropCloseTimer])

  const handlePageDroppedFiles = useCallback((files: File[]) => {
    if (files.length > 0) {
      clearPageDropCloseTimer()
      setShowPageDropOverlay(true)
      void handlePageDropUpload(files)
    } else if (!pageDropUploading) {
      setShowPageDropOverlay(false)
    }
  }, [clearPageDropCloseTimer, handlePageDropUpload, pageDropUploading])

  useEffect(() => {
    if (showUploadModal) return

    const handleWindowDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      showDocumentDropOverlay()
    }

    const handleWindowDragOver = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      event.dataTransfer!.dropEffect = 'copy'
      showDocumentDropOverlay()
    }

    const handleWindowDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()

      const outsideViewport =
        event.clientX <= 0 ||
        event.clientY <= 0 ||
        event.clientX >= window.innerWidth ||
        event.clientY >= window.innerHeight

      if (outsideViewport && !pageDropUploading) {
        setShowPageDropOverlay(false)
      }
    }

    const handleWindowDrop = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return
      event.preventDefault()
      handlePageDroppedFiles(Array.from(event.dataTransfer?.files ?? []))
    }

    window.addEventListener('dragenter', handleWindowDragEnter)
    window.addEventListener('dragover', handleWindowDragOver)
    window.addEventListener('dragleave', handleWindowDragLeave)
    window.addEventListener('drop', handleWindowDrop)

    return () => {
      window.removeEventListener('dragenter', handleWindowDragEnter)
      window.removeEventListener('dragover', handleWindowDragOver)
      window.removeEventListener('dragleave', handleWindowDragLeave)
      window.removeEventListener('drop', handleWindowDrop)
    }
  }, [handlePageDroppedFiles, pageDropUploading, showDocumentDropOverlay, showUploadModal])

  const handlePageDropOverlayDrag = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    clearPageDropCloseTimer()
    setShowPageDropOverlay(true)
  }, [clearPageDropCloseTimer])

  const handlePageDropOverlayDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()

    const files = Array.from(event.dataTransfer.files)
    handlePageDroppedFiles(files)
  }, [handlePageDroppedFiles])

  const closePageDropOverlay = useCallback(() => {
    if (pageDropUploading) return
    clearPageDropCloseTimer()
    setShowPageDropOverlay(false)
    resetPageDropUpload()
  }, [clearPageDropCloseTimer, pageDropUploading, resetPageDropUpload])

  const handleDeleteDocument = useCallback(async (doc: Document) => {
    await deleteDocument(doc.id)
    setDocuments(prev => prev.filter(existing => existing.id !== doc.id))
    setSelectedDocument(prev => prev?.id === doc.id ? null : prev)
  }, [])

  const handleRetryDocument = useCallback(async (doc: Document) => {
    const retried = await retryDocument(doc.id)
    setDocuments(prev => prev.map(existing => (
      existing.id === retried.id ? mergeDocumentUpdate(existing, retried) : existing
    )))
    setSelectedDocument(prev => (
      prev?.id === retried.id ? mergeDocumentUpdate(prev, retried) : prev
    ))
  }, [])

  const handleBulkDelete = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return
    const { succeeded } = await bulkDeleteDocuments(ids)
    const removed = new Set(succeeded)
    setDocuments(prev => prev.filter(doc => !removed.has(doc.id)))
    setSelectedDocument(prev => (prev && removed.has(prev.id) ? null : prev))
  }, [])

  const handleBulkMove = useCallback(async (ids: string[], folderId: string | null) => {
    if (ids.length === 0) return
    const { succeeded } = await bulkMoveDocuments(ids, folderId)
    // Moved docs leave the current view unless the destination is the folder on screen.
    if (folderId !== selectedFolderId) {
      const moved = new Set(succeeded)
      setDocuments(prev => prev.filter(doc => !moved.has(doc.id)))
      setSelectedDocument(prev => (prev && moved.has(prev.id) ? null : prev))
    }
  }, [selectedFolderId])

  const handleSelectFolder = (folderId: string | null, _folderName: string | null) => {
    navigate(folderId ? `/documents/${folderId}` : '/documents')
  }

  const handleBreadcrumbNavigate = (folderId: string | null, _folderName: string | null) => {
    navigate(folderId ? `/documents/${folderId}` : '/documents')
  }

  const handleFolderChildrenChanged = useCallback(async (parentId: string | null) => {
    if ((parentId ?? null) !== selectedFolderId) return
    await refetch()
  }, [refetch, selectedFolderId])

  const pageDropTargetName = selectedFolderId ? selectedFolderName ?? 'current folder' : 'Knowledgebase'

  return (
    <div className="flex flex-col lg:flex-row h-dvh bg-background">
      {/* Mobile-only top bar (hidden at lg+) */}
      <MobileTopBar />
      {/* Sidebar */}
      <AppSidebar activeSection="documents">
        <FolderTree
          selectedFolderId={selectedFolderId ?? null}
          onSelectFolder={handleSelectFolder}
          onAddFiles={() => setShowUploadModal(true)}
          onFolderChildrenChanged={handleFolderChildrenChanged}
        />
      </AppSidebar>

      {/* Main content */}
      <div className="flex-1 relative overflow-hidden bg-background min-w-0">
        <div className="absolute inset-0 overflow-auto">
          <div className="p-4 sm:p-6 lg:p-8 space-y-6">
            <div>
              {searchActive ? (
                <>
                  <h1 className="text-2xl font-semibold tracking-tight">Search results</h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Across all folders{debouncedSearch.trim() ? ` for "${debouncedSearch.trim()}"` : ''}
                  </p>
                </>
              ) : (
                <>
                  <FolderBreadcrumbs
                    folderId={selectedFolderId}
                    folderName={selectedFolderName}
                    onNavigate={handleBreadcrumbNavigate}
                    onFolderNameLoaded={setSelectedFolderName}
                  />
                  {selectedFolderId === null && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Documents the assistant can search and cite in chat. Upload files to add them to your knowledge base.
                    </p>
                  )}
                </>
              )}
            </div>

            <DocumentList
              folders={folders}
              documents={documents}
              loading={loading}
              hasMore={hasMore}
              currentFolderId={selectedFolderId}
              searchValue={searchQuery}
              searchActive={searchActive}
              onSearchChange={setSearchQuery}
              onLoadMore={loadMoreDocuments}
              onSelectFolder={handleSelectFolder}
              onSelectDocument={setSelectedDocument}
              onDeleteDocument={handleDeleteDocument}
              onRetryDocument={handleRetryDocument}
              onBulkDelete={handleBulkDelete}
              onBulkMove={handleBulkMove}
              onAddFiles={() => setShowUploadModal(true)}
            />
          </div>
        </div>
        {selectedDocument && (
          <DocsSidecar
            document={selectedDocument}
            onClose={() => setSelectedDocument(null)}
            onDeleted={(id) => {
              setDocuments(prev => prev.filter(d => d.id !== id))
              setSelectedDocument(null)
            }}
          />
        )}
      </div>

      {showPageDropOverlay && !showUploadModal && (
        <div
          data-testid="documents-page-drop-overlay"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 backdrop-blur-sm p-6 animate-fade-in"
          onDragEnter={handlePageDropOverlayDrag}
          onDragOver={handlePageDropOverlayDrag}
          onDrop={handlePageDropOverlayDrop}
        >
          <div className="relative w-full max-w-xl rounded-lg border-2 border-dashed border-primary/70 bg-card/95 p-8 text-center shadow-xl">
            <button
              type="button"
              aria-label="Close upload overlay"
              disabled={pageDropUploading}
              onClick={closePageDropOverlay}
              className="absolute right-4 top-4 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="space-y-4">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg bg-primary/10">
                {pageDropUploading ? (
                  <FileUp className="h-7 w-7 animate-bounce text-primary" />
                ) : (
                  <Upload className="h-7 w-7 text-primary" />
                )}
              </div>

              <div className="space-y-1">
                <h2 className="text-lg font-semibold">
                  {pageDropUploading ? 'Adding files...' : `Drop files into ${pageDropTargetName}`}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {DOCUMENT_UPLOAD_FORMAT_LABEL}
                </p>
              </div>

              {pageDropFeedback && (
                <div className={`mx-auto flex max-w-md items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm animate-fade-in ${
                  pageDropFeedback.type === 'info'
                    ? 'border border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-400'
                    : 'border border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-400'
                }`}>
                  {pageDropFeedback.type === 'info' ? (
                    <Info className="h-4 w-4 flex-shrink-0" />
                  ) : (
                    <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500" />
                  )}
                  {pageDropFeedback.message}
                </div>
              )}

              {pageDropError && (
                <div className="mx-auto flex max-w-md items-center justify-center gap-2 text-sm text-destructive animate-fade-in">
                  <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-destructive" />
                  {pageDropError}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowUploadModal(false)}
          />
          {/* Modal */}
          <div className="relative bg-card border border-border rounded-2xl p-6 w-full max-w-lg mx-4 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Upload Files</h2>
              <button
                onClick={() => setShowUploadModal(false)}
                className="p-1 rounded-lg hover:bg-muted transition-colors"
              >
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
            <DocumentUpload
              onUploadComplete={async () => {
                await refetch()
                setShowUploadModal(false)
              }}
              onSkipped={() => {
                // Keep modal open so user sees the "skipped" notification
              }}
              folderId={selectedFolderId ?? null}
            />
          </div>
        </div>
      )}
    </div>
  )
}
