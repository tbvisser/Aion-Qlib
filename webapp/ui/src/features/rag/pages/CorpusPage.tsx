import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FileText, Layers3, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/useAuth'
import { useDebouncedValue } from '@/features/rag/hooks/useDebouncedValue'
import { getDocumentChunks, listDocuments, type ChunkInfo } from '@/features/rag/lib/api'
import type { Document } from '@/features/rag/types'

// Read-only inspector over the ingested corpus: which documents exist and how
// each one was cut into chunks. No mutations live here — uploading, deleting
// and retrying all stay on /documents.

const LIMIT = 100

const STATUS_DOT: Record<Document['status'], string> = {
  pending: 'bg-amber-500',
  processing: 'bg-blue-500',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
}

// The collapsed row shows the first line or two of the chunk, with blank lines
// dropped so a leading heading gap doesn't render as an empty preview.
function chunkPreview(content: string): string {
  const lines = content.split('\n').map(line => line.trim()).filter(Boolean)
  const preview = lines.slice(0, 2).join(' ')
  return preview.length > 220 ? `${preview.slice(0, 220)}...` : preview
}

function sectionPath(meta: Record<string, unknown> | null): string | null {
  const path = meta?.cascading_path ?? meta?.section ?? meta?.heading
  return typeof path === 'string' && path.trim() ? path : null
}

function tokenCount(meta: Record<string, unknown> | null): number | null {
  const tokens = meta?.token_count ?? meta?.tokens
  return typeof tokens === 'number' ? tokens : null
}

export function CorpusPage() {
  const { documentId: urlDocumentId } = useParams<{ documentId?: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [documents, setDocuments] = useState<Document[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [filter, setFilter] = useState('')
  const debouncedFilter = useDebouncedValue(filter, 250)

  const [chunks, setChunks] = useState<ChunkInfo[]>([])
  const [chunksLoading, setChunksLoading] = useState(false)
  const [chunksError, setChunksError] = useState(false)
  const [expandedChunk, setExpandedChunk] = useState<number | null>(null)

  // The whole corpus, not one folder: listDocuments without a folderId spans
  // every folder, which is the view this page is about.
  useEffect(() => {
    if (!user) return
    const controller = new AbortController()

    setLoading(true)
    listDocuments({ limit: LIMIT })
      .then(response => {
        if (controller.signal.aborted) return
        setDocuments(response?.documents ?? [])
        setHasMore(response?.has_more ?? false)
      })
      .catch(error => {
        if (!controller.signal.aborted) console.error('Failed to load corpus documents:', error)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
    // user?.id, not user: the session object gets a fresh identity on every
    // token refresh, which would otherwise blank the sidebar once an hour.
  }, [user?.id])

  const selectedDocument = useMemo(
    () => (urlDocumentId ? documents.find(doc => doc.id === urlDocumentId) ?? null : null),
    [documents, urlDocumentId],
  )

  // Chunks load lazily per selection, and only once a document is on screen.
  useEffect(() => {
    if (!urlDocumentId) {
      setChunks([])
      setExpandedChunk(null)
      return
    }
    const controller = new AbortController()

    setChunksLoading(true)
    setChunksError(false)
    setExpandedChunk(null)
    getDocumentChunks(urlDocumentId)
      .then(data => { if (!controller.signal.aborted) setChunks(data) })
      .catch(() => {
        if (!controller.signal.aborted) {
          setChunks([])
          setChunksError(true)
        }
      })
      .finally(() => { if (!controller.signal.aborted) setChunksLoading(false) })

    return () => controller.abort()
  }, [urlDocumentId])

  const visibleDocuments = useMemo(() => {
    const term = debouncedFilter.trim().toLowerCase()
    if (!term) return documents
    return documents.filter(doc => doc.filename.toLowerCase().includes(term))
  }, [documents, debouncedFilter])

  const handleSelect = useCallback((doc: Document) => {
    navigate(`/corpus/${doc.id}`)
  }, [navigate])

  const totalChars = useMemo(
    () => chunks.reduce((sum, chunk) => sum + chunk.content.length, 0),
    [chunks],
  )

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border/50">
        <div className="sticky top-0 z-10 bg-background/95 p-3 backdrop-blur">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter documents"
              aria-label="Filter documents"
              data-testid="corpus-filter"
              className="w-full rounded-lg border border-border/50 bg-transparent py-1.5 pl-8 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary/50"
            />
          </div>
        </div>

        {loading ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">Loading corpus...</div>
        ) : documents.length === 0 ? (
          <div className="px-3 py-3 text-center text-xs text-muted-foreground">
            Nothing ingested yet. Upload via /documents.
          </div>
        ) : visibleDocuments.length === 0 ? (
          <div className="px-3 py-3 text-center text-xs text-muted-foreground">
            No document matches "{debouncedFilter.trim()}".
            {hasMore && <> Only the first {LIMIT} documents were searched.</>}
          </div>
        ) : (
          <div className="space-y-0.5 pb-3">
            {visibleDocuments.map(doc => {
              const isSelected = doc.id === urlDocumentId
              return (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => handleSelect(doc)}
                  data-testid={`corpus-doc-${doc.id}`}
                  data-selected={isSelected ? 'true' : 'false'}
                  className={cn(
                    'mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-xl px-2 py-2 text-left transition-all duration-200',
                    isSelected ? 'bg-accent/80 shadow-sm' : 'hover:bg-accent/50',
                  )}
                >
                  <FileText className={cn(
                    'h-4 w-4 shrink-0 transition-colors',
                    isSelected ? 'text-primary' : 'text-muted-foreground',
                  )} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm" title={doc.filename}>{doc.filename}</p>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[doc.status])} />
                      {doc.chunk_count} chunk{doc.chunk_count === 1 ? '' : 's'}
                    </p>
                  </div>
                </button>
              )
            })}
            {hasMore && (
              <p className="px-4 pt-2 text-xs text-muted-foreground">
                Showing the first {LIMIT} documents.
              </p>
            )}
          </div>
        )}
      </aside>

      <div className="min-w-0 flex-1 overflow-auto">
        {loading && !selectedDocument ? (
          // Deep links land here before the list resolves; without this gate
          // they would flash the "nothing ingested" copy while loading.
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !selectedDocument ? (
          <div className="flex h-full items-center justify-center p-8">
            <div className="max-w-sm text-center">
              <Layers3 className="mx-auto h-8 w-8 text-muted-foreground/60" />
              <h1 className="mt-3 text-lg font-semibold">Corpus inspector</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {urlDocumentId
                  ? hasMore
                    ? `This document is not among the first ${LIMIT} loaded. Open it from /documents instead.`
                    : 'This document is not in the corpus — it may have been deleted.'
                  : documents.length === 0
                    ? 'No documents have been ingested yet. Upload files on /documents and they will appear here once chunked.'
                    : 'Pick a document to see how it was chunked for retrieval.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6 p-4 animate-fade-in sm:p-6 lg:p-8">
            <div>
              <h1 className="truncate text-2xl font-semibold tracking-tight" title={selectedDocument.filename}>
                {selectedDocument.filename}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[selectedDocument.status])} />
                  {selectedDocument.status}
                </span>
                <span>{selectedDocument.chunk_count} chunks indexed</span>
                {chunks.length > 0 && <span>{totalChars.toLocaleString()} chars loaded</span>}
                <span>{selectedDocument.file_type}</span>
              </div>
            </div>

            {chunksLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : chunksError ? (
              <p className="text-sm text-destructive">Could not load chunks for this document.</p>
            ) : chunks.length === 0 ? (
              <p className="text-sm italic text-muted-foreground">
                {selectedDocument.status === 'completed'
                  ? 'This document has no chunks.'
                  : `No chunks yet — ingestion is ${selectedDocument.status}.`}
              </p>
            ) : (
              <div className="space-y-2" data-testid="corpus-chunks">
                {chunks.map(chunk => {
                  const meta = chunk.metadata as Record<string, unknown> | null
                  const isExpanded = expandedChunk === chunk.chunk_index
                  const path = sectionPath(meta)
                  const tokens = tokenCount(meta)
                  return (
                    <div key={chunk.id} className="overflow-hidden rounded-lg border border-border/50">
                      <button
                        type="button"
                        onClick={() => setExpandedChunk(isExpanded ? null : chunk.chunk_index)}
                        data-testid={`corpus-chunk-${chunk.chunk_index}`}
                        className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/30"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-bold text-primary">
                          {chunk.chunk_index}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {path || `Chunk ${chunk.chunk_index}`}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {chunkPreview(chunk.content) || 'Empty chunk'}
                          </p>
                          <div className="flex gap-3 pt-0.5 text-xs text-muted-foreground">
                            <span>{chunk.content.length} chars</span>
                            {tokens !== null && <span>{tokens} tokens</span>}
                            {Array.isArray(meta?.childRange) && (
                              <span>child: [{(meta.childRange as number[]).join('-')}]</span>
                            )}
                            {Array.isArray(meta?.parentRange) && (
                              <span>parent: [{(meta.parentRange as number[]).join('-')}]</span>
                            )}
                          </div>
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">{isExpanded ? 'v' : '>'}</span>
                      </button>
                      {isExpanded && (
                        <div className="border-t border-border/50">
                          <pre className="max-h-96 overflow-auto whitespace-pre-wrap bg-muted/20 p-3 font-mono text-xs">
                            {chunk.content}
                          </pre>
                          {meta && Object.keys(meta).length > 0 && (
                            <div className="border-t border-border/30 bg-muted/10 p-3">
                              <p className="mb-1 text-xs font-medium text-muted-foreground">Metadata</p>
                              <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
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
            )}
          </div>
        )}
      </div>
    </div>
  )
}
