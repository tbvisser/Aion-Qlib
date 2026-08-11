import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ThreadList } from '@/features/rag/components/chat/ThreadList'

/**
 * Chat history, as its own page.
 *
 * The conversation itself now lives on the dashboard, so this is a pure
 * archive: search, browse by day, rename, delete — and open, which hands off
 * to `/dashboard/:threadId`. No composer and no selection state, since nothing
 * is ever "selected" here; a click navigates away.
 *
 * The only "New Chat" affordance is ThreadList's own button. A second one in
 * the header would sit a few pixels above it doing exactly the same thing.
 */
export function ChatsHistoryPage() {
  const navigate = useNavigate()

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="mx-auto flex h-full w-full min-h-0 max-w-3xl flex-col px-3 py-5">
        <h1 className="shrink-0 px-3 text-lg font-semibold tracking-tight">Chats</h1>

        <div className="min-h-0 flex-1">
          <ThreadList
            selectedThreadId={null}
            onSelectThread={(threadId) =>
              navigate(threadId ? `/dashboard/${threadId}` : '/dashboard')
            }
          />
        </div>
      </div>
    </div>
  )
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
