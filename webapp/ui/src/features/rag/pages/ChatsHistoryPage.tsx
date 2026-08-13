import { useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { ThreadList } from '@/features/rag/components/chat/ThreadList'
import { IndexHeader } from '@/components/layout/IndexHeader'
import { Button } from '@/components/ui/button'
import { deleteThread } from '@/features/rag/lib/api'

/**
 * Chat history, as its own page.
 *
 * The conversation itself lives on the dashboard, so this is a pure archive:
 * search, browse, rename, delete — and open, which hands off to
 * `/dashboard/:threadId`.
 *
 * The header owns the chrome now: search, the Select toggle and New all live up
 * there beside the title, and `ThreadList` renders only the list. It used to
 * own its own New Chat button and search box; a second copy of each a few
 * pixels below the header would be two controls doing one job.
 */

type Filter = 'all' | 'today' | 'week'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
]

export function ChatsHistoryPage() {
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [deleting, setDeleting] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const togglePicked = (threadId: string) =>
    setPicked((ids) =>
      ids.includes(threadId) ? ids.filter((id) => id !== threadId) : [...ids, threadId],
    )

  const stopPicking = () => {
    setPicking(false)
    setPicked([])
  }

  const deletePicked = async () => {
    setDeleting(true)
    try {
      // Sequential, not `Promise.all`: a bulk delete that half-fails should
      // leave a list the next reload can still explain, not a race.
      for (const id of picked) {
        await deleteThread(id)
      }
    } catch (error) {
      console.error('Failed to delete threads:', error)
    } finally {
      setDeleting(false)
      stopPicking()
      setReloadKey((key) => key + 1)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <IndexHeader
        title="Chats and tasks"
        search={{
          value: query,
          onChange: setQuery,
          open: searchOpen,
          onOpenChange: setSearchOpen,
          placeholder: 'Search chats…',
        }}
        menus={[
          {
            label: 'Filter by',
            value: filter,
            options: FILTERS,
            onChange: (value) => setFilter(value as Filter),
            testId: 'chats-filter',
          },
        ]}
        actions={
          picking ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={picked.length === 0 || deleting}
                onClick={() => void deletePicked()}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                {deleting ? 'Deleting…' : `Delete ${picked.length}`}
              </Button>
              <Button variant="ghost" size="sm" onClick={stopPicking}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
                Select
              </Button>
              <Button size="sm" onClick={() => navigate('/dashboard')}>
                <Plus className="mr-1 h-3.5 w-3.5" /> New
              </Button>
            </>
          )
        }
      />

      <div className="min-h-0 flex-1">
        <div className="mx-auto flex h-full w-full min-h-0 max-w-3xl flex-col px-3 py-2">
          <ThreadList
            selectedThreadId={null}
            onSelectThread={(threadId) =>
              navigate(threadId ? `/dashboard/${threadId}` : '/dashboard')
            }
            search={query}
            hideChrome
            reloadKey={reloadKey}
            selection={picking ? { ids: picked, onToggle: togglePicked } : undefined}
            since={sinceFor(filter)}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The filter, as the cutoff it really is. `all` is undefined rather than a very
 * old date so the list does no date work at all in the common case.
 */
function sinceFor(filter: Filter): string | undefined {
  if (filter === 'all') return undefined
  const now = new Date()
  if (filter === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return start.toISOString()
  }
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * `/chats/:threadId` used to be where a conversation was read. Links, browser
 * history and anything already sent out keep working by landing on the
 * dashboard copy of that thread — carrying any location state (a kickoff
 * prompt from Skills, say) across with them.
 */
export function ChatThreadRedirect() {
  const { threadId } = useParams<{ threadId: string }>()
  const location = useLocation()

  return <Navigate to={`/dashboard/${threadId}`} replace state={location.state} />
}
