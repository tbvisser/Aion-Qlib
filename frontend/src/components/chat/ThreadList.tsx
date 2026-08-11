import { useState, useEffect, forwardRef, useImperativeHandle, useRef, useCallback } from 'react'
import { MessageSquarePlus, Trash2, Pencil, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { InlineEdit } from '@/components/folders/InlineEdit'
import { listThreads, deleteThread, updateThread } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import type { Thread } from '@/types'
import { cn } from '@/lib/utils'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'

const PAGE_SIZE = 50

interface ThreadListProps {
  selectedThreadId: string | null
  onSelectThread: (threadId: string) => void
}

export interface ThreadListRef {
  updateThreadTitle: (threadId: string, title: string) => void
  addThread: (thread: Thread) => void
}

export const ThreadList = forwardRef<ThreadListRef, ThreadListProps>(
  function ThreadList({ selectedThreadId, onSelectThread }, ref) {
  const [threads, setThreads] = useState<Thread[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  const [searchInput, setSearchInput] = useState('')
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

  useImperativeHandle(ref, () => ({
    updateThreadTitle: (threadId: string, title: string) => {
      setThreads(prev => prev.map(t =>
        t.id === threadId ? { ...t, title } : t
      ))
    },
    addThread: (thread: Thread) => {
      setThreads(prev => [thread, ...prev])
    }
  }))

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
  }, [debouncedSearch])

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

  const deletingSelectedThread = Boolean(threadToDelete && deletingThreadId === threadToDelete.id)

  return (
    <>
    <div className="flex h-full flex-col">
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
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search threads..."
            aria-label="Search threads"
            className="pl-9 pr-8 h-9 rounded-xl"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-accent/50 transition-colors"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-muted-foreground text-sm">Loading...</div>
          </div>
        ) : threads.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {isSearching
              ? `No threads match "${debouncedSearch}"`
              : 'No conversations yet. Start a new chat!'}
          </div>
        ) : (
          <>
            <div className="space-y-0.5">
              {threads.map((thread) => {
                const isEditing = editingThreadId === thread.id
                return (
                <a
                  key={thread.id}
                  href={isEditing ? undefined : `/chat/${thread.id}`}
                  onClick={(e) => {
                    if (isEditing) {
                      e.preventDefault()
                      return
                    }
                    if (e.ctrlKey || e.metaKey || e.shiftKey) return
                    e.preventDefault()
                    onSelectThread(thread.id)
                  }}
                  className={cn(
                    "group flex cursor-pointer items-center justify-between rounded-xl px-3 py-2.5 text-sm transition-colors no-underline text-foreground",
                    selectedThreadId === thread.id
                      ? "bg-accent/80 shadow-sm"
                      : "hover:bg-accent/50"
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2.5 flex-1">
                    {isEditing ? (
                      <InlineEdit
                        value={thread.title}
                        onSave={(newTitle) => handleRenameThread(thread.id, newTitle)}
                        onCancel={() => setEditingThreadId(null)}
                      />
                    ) : (
                      <span className="truncate">{thread.title}</span>
                    )}
                  </div>
                  {!isEditing && (
                    // Collapsed to zero width at rest so the title can use the
                    // full row; expands (and fades in) on hover/focus, letting
                    // the title truncate to make room for the actions.
                    <div className="flex shrink-0 items-center gap-0.5 overflow-hidden max-w-0 pl-1 opacity-0 transition-all duration-200 group-hover:max-w-[4.5rem] group-hover:opacity-100 focus-within:max-w-[4.5rem] focus-within:opacity-100">
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
                </a>
                )
              })}
            </div>

            {hasMore && (
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
                    Loading more...
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
            {deletingSelectedThread ? 'Deleting...' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
})
