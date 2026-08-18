import { useState, useRef, useEffect } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { History, MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AionMark } from '@/components/AionMark'
import { AgendaWidget } from '@/components/dashboard/AgendaWidget'
import { MarketHoursWidget } from '@/components/MarketHoursWidget'
import { ChatSurface } from '@/features/rag/components/chat/ChatSurface'
import { WelcomeComposer } from '@/features/rag/components/chat/WelcomeComposer'
import { type ComposerMode } from '@/features/rag/components/chat/ComposerMenu'
import { createThread } from '@/features/rag/lib/api'
import { getGreetingHeadline, getFirstName } from '@/lib/greeting'
import { navItemFor, type SectionKey } from '@/components/layout/NavItems'
import { cn } from '@/lib/utils'

// Shortcut buttons under the composer. The platform points these at four of its
// own destinations; here they point at four pages this app actually backs, one
// per section, so every pill leads somewhere real. Keep them all `built` — a
// dimmed "Soon" destination behind a hero pill is a dead end.
const HOME_SHORTCUT_KEYS: SectionKey[] = ['markets', 'macro', 'tl-builder', 'tl-database']
const HOME_SHORTCUTS = HOME_SHORTCUT_KEYS
  .map(navItemFor)
  .filter((item): item is NonNullable<typeof item> => Boolean(item))

// While the composer holds a draft the page recedes, the way the platform's does:
// everything around the box fades and stops taking clicks but keeps its space, so
// the greeting and the composer stay exactly where they were.
const recede = (hidden: boolean) =>
  cn(
    'transition-[opacity,transform] duration-300 ease-out',
    hidden ? 'pointer-events-none translate-y-1 opacity-0' : 'translate-y-0 opacity-100',
  )

/** What the welcome composer handed to the thread it just created. */
interface PendingHandoff {
  threadId: string
  message: string
  attachments?: File[]
  mode?: ComposerMode
}

/**
 * Home screen, matching the Aion Platform's dashboard: centered greeting,
 * composer, shortcut pills and the market-hours strip — and, once a thread
 * exists, the chat itself. `/dashboard` is the idle home; `/dashboard/:threadId`
 * is that same home turned over to the conversation.
 */
export function DashboardPage() {
  const { threadId } = useParams<{ threadId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [creating, setCreating] = useState(false)
  const [welcomeFocusRequest, setWelcomeFocusRequest] = useState(0)
  // True while the composer holds a draft — see `recede` above.
  const [composerActive, setComposerActive] = useState(false)
  // What the composer handed off to the thread it created. Read once, by the
  // thread it names — see the guard below.
  const [pendingHandoff, setPendingHandoff] = useState<PendingHandoff | null>(null)
  const locationStateHandledRef = useRef(false)

  // Drop the handoff as soon as the route moves off the thread it was meant
  // for (including back to the idle home). ChatView resets its "already sent"
  // ref on every threadId change, so a handoff left lying around would be
  // re-sent into whichever thread is opened next.
  useEffect(() => {
    setPendingHandoff(prev => (prev && prev.threadId === threadId ? prev : null))
  }, [threadId])

  const handoff = pendingHandoff && pendingHandoff.threadId === threadId ? pendingHandoff : null

  // A kickoff prompt handed over by another page (Skills' "Use skill" and
  // "Create with AI", the skill editor's "Try in Chat") arrives as location
  // state. Mount-only: the ref keeps StrictMode's double-invoked effect from
  // creating two threads, since replaceState below is invisible to the router.
  useEffect(() => {
    const stateMessage = (location.state as { initialMessage?: string } | null)?.initialMessage
    if (!stateMessage || locationStateHandledRef.current) return
    locationStateHandledRef.current = true

    // Clear the location state so it doesn't re-trigger on re-render.
    window.history.replaceState({}, '')

    setCreating(true)
    createThread()
      .then((newThread) => {
        setPendingHandoff({ threadId: newThread.id, message: stateMessage })
        navigate(`/dashboard/${newThread.id}`, { replace: true })
      })
      .catch((error) => {
        console.error('Failed to create thread from location state:', error)
      })
      .finally(() => {
        setCreating(false)
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleWelcomeSubmit = async ({
    message,
    attachments,
    mode,
  }: { message: string; attachments: File[]; mode: ComposerMode }) => {
    setCreating(true)
    try {
      const newThread = await createThread()
      setPendingHandoff({ threadId: newThread.id, message, attachments, mode })
      // Pushed, not replaced: Back from a fresh thread returns to the home screen.
      navigate(`/dashboard/${newThread.id}`)
    } catch (error) {
      console.error('Failed to create thread:', error)
      // Re-throw so the composer keeps the user's message and attachments.
      throw error
    } finally {
      setCreating(false)
    }
  }

  if (threadId) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/50 px-4">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setWelcomeFocusRequest(request => request + 1)
              navigate('/dashboard')
            }}
          >
            <MessageSquarePlus className="h-4 w-4" />
            New Chat
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => navigate('/chats')}
          >
            <History className="h-4 w-4" />
            History
          </Button>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <ChatSurface
            threadId={threadId}
            initialMessage={handoff?.message}
            initialAttachments={handoff?.attachments}
            initialMode={handoff?.mode}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full">
      {/* Calendar corner, matching the platform's collapsed widget — live now
          that the macro calendar API exists. */}
      <div
        className={cn('absolute right-4 top-4 z-10 hidden lg:block', recede(composerActive))}
        style={{ transitionDelay: composerActive ? '0ms' : '80ms' }}
        aria-hidden={composerActive}
      >
        <AgendaWidget />
      </div>

      <div className="flex h-full flex-col items-center justify-center">
        <div className="mb-8 flex items-center justify-center gap-3">
          <AionMark className="h-8" />
          <h1 className="font-serif text-3xl tracking-tight text-foreground/90 md:text-4xl">
            {getGreetingHeadline()}, {getFirstName()}
          </h1>
        </div>

        <div className="flex w-full max-w-2xl flex-col items-center">
          <WelcomeComposer
            onSubmit={handleWelcomeSubmit}
            busy={creating}
            placeholder="Ask about the data, test a factor, or run a backtest"
            focusToken={welcomeFocusRequest}
            onDraftChange={setComposerActive}
          />
        </div>

        <div
          className={cn(
            'mt-4 flex flex-wrap items-center justify-center gap-2 px-4',
            recede(composerActive),
          )}
          aria-hidden={composerActive}
        >
          {HOME_SHORTCUTS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => navigate(item.route)}
              // Faded out, they keep their space but must leave the tab order too.
              tabIndex={composerActive ? -1 : undefined}
              className="flex items-center gap-1.5 rounded-full border border-border/50 bg-surface-2 px-3.5 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:bg-surface-3 hover:text-foreground"
            >
              <item.icon className="h-4 w-4 text-muted-foreground" />
              {item.label}
            </button>
          ))}
        </div>

        <div
          className={cn('mt-4 hidden w-full max-w-2xl px-4 sm:block', recede(composerActive))}
          style={{ transitionDelay: composerActive ? '0ms' : '80ms' }}
          aria-hidden={composerActive}
        >
          <MarketHoursWidget />
        </div>
      </div>
    </div>
  )
}
