import { useState, useEffect, useRef, useCallback } from 'react'
import { MessageSquarePlus, MessageCircle, Trash2, Pencil, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
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
import { InlineEdit } from '@/features/rag/components/folders/InlineEdit'
import { listThreads, deleteThread, updateThread } from '@/features/rag/lib/api'
import { supabase } from '@/lib/supabase'
import type { Thread } from '@/features/rag/types'
import { cn } from '@/lib/utils'
import { useDebouncedValue } from '@/features/rag/hooks/useDebouncedValue'
import { formatRelativeStamp } from '@/lib/time'

const PAGE_SIZE = 50

interface ThreadListProps {
  selectedThreadId: string | null
  onSelectThread: (threadId: string) => void
  /**
   * Controlled search, driven by the page header. When given, the built-in
   * search box is not rendered — two boxes filtering one list is a bug the
   * user gets to discover.
   */
  search?: string
  /** Drop the built-in New Chat button and search box; the page owns them. */
  hideChrome?: boolean
  /**
   * Multi-select. Present means rows carry a checkbox and a click toggles
   * rather than navigating — you cannot be picking rows and leaving the page
   * with the same gesture.
   */
  selection?: { ids: readonly string[]; onToggle: (threadId: string) => void }
  /** Bump to force a re-read, after the page deletes threads out from under us. */
  reloadKey?: number
  /**
   * ISO cutoff: hide anything older, and stop paging once the list reaches it.
   *
   * Filtering client-side is exact here rather than approximate, because the
   * server returns threads in `updated_at`-descending order — everything newer
   * than a cutoff is a prefix of that list, so the first row that falls before
   * it proves no later page can contain a match.
   */
  since?: string
}

export function ThreadList({
  selectedThreadId,
  onSelectThread,
  search,
  hideChrome = false,
  selection,
  reloadKey = 0,
  since,
}: ThreadListProps) {
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  const [ownSearchInput, setOwnSearchInput] = useState('')
  const searchInput = search ?? ownSearchInput
  const debouncedSearch = useDebouncedValue(searchInput, 250)

  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [threadToDelete, setThreadToDelete] = useState<Thread | null>(null)
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null)

  const sentinelRef = useRef<HTMLDivElement>(null)
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null)
  const requestIdRef = useRef(0)
  // Synchronous re-entrancy guard — state-based loadingMore can be bypassed by
  // back-to-back IntersectionObserver firings before React commits the update.
  const isLoadingMoreRef = useRef(false)

  // Initial load + reload whenever the debounced search term changes
  useEffect(() => {
    const myId = ++requestIdRef.current
    setLoading(true)
    setOffset(0)
    setLoadMoreError(null)
    isLoadingMoreRef.current = false
    listThreads({ search: debouncedSearch, offset: 0, limit: PAGE_SIZE })
      .then((res) => {
        if (myId !== requestIdRef.current) return
        setThreads(res.threads)
        setHasMore(res.has_more)
        setOffset(res.threads.length)
      })
      .catch((err) => {
        if (myId !== requestIdRef.current) return
        console.error('Failed to load threads:', err)
      })
      .finally(() => {
        if (myId !== requestIdRef.current) return
        setLoading(false)
      })
  }, [debouncedSearch, reloadKey])

  const loadMore = useCallback(async () => {
    if (isLoadingMoreRef.current || loading || !hasMore || loadMoreError) return
    isLoadingMoreRef.current = true
    setLoadingMore(true)
    const myId = requestIdRef.current
    try {
      const res = await listThreads({
        search: debouncedSearch,
        offset,
        limit: PAGE_SIZE,
      })
      if (myId !== requestIdRef.current) return
      setThreads(prev => [...prev, ...res.threads])
      setHasMore(res.has_more)
      setOffset(prev => prev + res.threads.length)
    } catch (err) {
      if (myId !== requestIdRef.current) return
      console.error('Failed to load more threads:', err)
      setLoadMoreError(err instanceof Error ? err.message : 'Failed to load more threads')
    } finally {
      isLoadingMoreRef.current = false
      if (myId === requestIdRef.current) setLoadingMore(false)
    }
  }, [debouncedSearch, offset, hasMore, loading, loadMoreError])

  // IntersectionObserver — fires loadMore when sentinel is visible
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore || loading) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore()
      },
      { threshold: 0.1 }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loading, loadMore])

  // Realtime: update thread titles when they change in the DB
  useEffect(() => {
    const channel = supabase
      .channel('threads-title-updates')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'threads',
        },
        (payload) => {
          const updated = payload.new as Thread
          setThreads(prev => prev.map(t =>
            t.id === updated.id ? { ...t, title: updated.title, updated_at: updated.updated_at } : t
          ))
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const handleCreateThread = () => {
    // Don't create a thread on the backend yet — that happens when the user
    // sends their first message from the welcome screen. Just clear the
    // current selection so the welcome input is shown.
    onSelectThread('')
  }

  const handleRequestDeleteThread = (e: React.MouseEvent, thread: Thread) => {
    e.preventDefault()
    e.stopPropagation()
    setThreadToDelete(thread)
  }

  const handleConfirmDeleteThread = async () => {
    if (!threadToDelete || deletingThreadId) return
    const threadId = threadToDelete.id
    setDeletingThreadId(threadId)
    try {
      await deleteThread(threadId)
      setThreads(prev => prev.filter(t => t.id !== threadId))
      if (selectedThreadId === threadId) {
        onSelectThread('')
      }
      setThreadToDelete(null)
    } catch (error) {
      console.error('Failed to delete thread:', error)
    } finally {
      setDeletingThreadId(null)
    }
  }

  const handleRenameThread = async (threadId: string, newTitle: string) => {
    setEditingThreadId(null)
    try {
      await updateThread(threadId, newTitle)
      setThreads(prev => prev.map(t =>
        t.id === threadId ? { ...t, title: newTitle } : t
      ))
    } catch (error) {
      console.error('Failed to rename thread:', error)
    }
  }

  const isSearching = debouncedSearch.trim().length > 0

  // See the `since` prop: the cutoff is a prefix of a recency-ordered list, so
  // truncating at the first row past it is the whole filter — and once it has
  // bitten, there is nothing further worth fetching.
  const cutIndex = since ? threads.findIndex((t) => t.updated_at < since) : -1
  const visibleThreads = cutIndex === -1 ? threads : threads.slice(0, cutIndex)
  const canLoadMore = hasMore && cutIndex === -1

  const deletingSelectedThread = Boolean(threadToDelete && deletingThreadId === threadToDelete.id)

  // One flat, recency-ordered list. Day headers were dropped when every row
  // gained its own stamp: "16 minutes ago" under a "Today" heading says the
  // same thing twice, and the flat list is what a search result already had to
  // be anyway.
  const renderThreadRow = (thread: Thread) => {
    const isEditing = editingThreadId === thread.id
    const isPicked = selection?.ids.includes(thread.id) ?? false
    return (
      <a
        key={thread.id}
        href={isEditing || selection ? undefined : `/dashboard/${thread.id}`}
        onClick={(e) => {
          if (isEditing) {
            e.preventDefault()
            return
          }
          // While picking, a click picks. Navigating away mid-selection would
          // throw away everything already ticked.
          if (selection) {
            e.preventDefault()
            selection.onToggle(thread.id)
            return
          }
          if (e.ctrlKey || e.metaKey || e.shiftKey) return
          e.preventDefault()
          onSelectThread(thread.id)
        }}
        className={cn(
          'group flex cursor-pointer items-center gap-3 border-b border-border/50 px-3 py-3 text-sm no-underline transition-colors text-foreground',
          selectedThreadId === thread.id || isPicked
            ? 'bg-foreground/[0.04]'
            : 'hover:bg-foreground/[0.03]',
        )}
      >
        {selection ? (
          <Checkbox
            checked={isPicked}
            onCheckedChange={() => selection.onToggle(thread.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${thread.title}`}
            className="shrink-0"
          />
        ) : (
          <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground/60" />
        )}

        <div className="min-w-0 flex-1">
          {isEditing ? (
            <InlineEdit
              value={thread.title}
              onSave={(newTitle) => handleRenameThread(thread.id, newTitle)}
              onCancel={() => setEditingThreadId(null)}
            />
          ) : (
            <span className="block truncate">{thread.title}</span>
          )}
        </div>

        {!isEditing && !selection && (
          // Collapsed to zero width at rest so the stamp keeps its place;
          // expands (and fades in) on hover/focus.
          <div className="flex shrink-0 items-center gap-0.5 overflow-hidden max-w-0 opacity-0 transition-all duration-200 group-hover:max-w-[4.5rem] group-hover:opacity-100 focus-within:max-w-[4.5rem] focus-within:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-lg hover:bg-accent transition-colors duration-200"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setEditingThreadId(thread.id)
              }}
              aria-label="Rename thread"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors duration-200"
              onClick={(e) => handleRequestDeleteThread(e, thread)}
              aria-label="Delete thread"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {!isEditing && (
          <span className="shrink-0 font-mono text-label text-muted-foreground/70">
            {formatRelativeStamp(thread.updated_at)}
          </span>
        )}
      </a>
    )
  }

  return (
    <>
    <div className="flex h-full flex-col">
      {!hideChrome && (
        <div className="p-3 space-y-2">
          <Button
            variant="ghost"
            onClick={handleCreateThread}
            className="w-full h-10 justify-start rounded-xl border border-foreground/15 bg-transparent transition-all duration-200 btn-press"
          >
            <MessageSquarePlus className="mr-2 h-4 w-4" />
            New Chat
          </Button>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
            <Input
              type="text"
              value={searchInput}
              onChange={(e) => setOwnSearchInput(e.target.value)}
              placeholder="Search threads…"
              aria-label="Search threads"
              className="pl-9 pr-8 h-9 rounded-xl"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setOwnSearchInput('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-accent/50 transition-colors"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-muted-foreground text-sm">Loading…</div>
          </div>
        ) : visibleThreads.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {isSearching
              ? `No threads match "${debouncedSearch}"`
              : since
                ? 'No conversations in this period.'
                : 'No conversations yet. Start a new chat!'}
          </div>
        ) : (
          <>
            <div>{visibleThreads.map(renderThreadRow)}</div>

            {canLoadMore && (
              <div ref={sentinelRef} className="flex justify-center py-3">
                {loadMoreError ? (
                  <button
                    type="button"
                    onClick={() => { setLoadMoreError(null); loadMore() }}
                    className="text-xs text-destructive hover:underline"
                  >
                    Failed to load more. Click to retry.
                  </button>
                ) : loadingMore ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    Loading more…
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </div>

    <AlertDialog
      open={threadToDelete !== null}
      onOpenChange={(open) => {
        if (!open && !deletingSelectedThread) setThreadToDelete(null)
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          confirmDeleteButtonRef.current?.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete "{threadToDelete?.title ?? 'this chat'}" and its messages. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletingSelectedThread}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            ref={confirmDeleteButtonRef}
            onClick={(event) => {
              event.preventDefault()
              void handleConfirmDeleteThread()
            }}
            disabled={deletingSelectedThread}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deletingSelectedThread ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
