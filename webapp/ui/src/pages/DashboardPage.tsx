import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUp, CalendarDays } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { MarketHoursWidget } from '@/components/MarketHoursWidget'
import { getGreetingHeadline, getFirstName } from '@/lib/greeting'
import { navItemFor, type SectionKey } from '@/components/layout/NavItems'

// Shortcut buttons under the composer. The platform points these at four of its
// own destinations; here they point at four pages this app actually backs, one
// per section, so every pill leads somewhere real. Keep them all `built` — a
// dimmed "Soon" destination behind a hero pill is a dead end.
const HOME_SHORTCUT_KEYS: SectionKey[] = ['markets', 'macro', 'tl-builder', 'tl-databank']
const HOME_SHORTCUTS = HOME_SHORTCUT_KEYS
  .map(navItemFor)
  .filter((item): item is NonNullable<typeof item> => Boolean(item))

/**
 * Home screen, matching the Aion Platform's dashboard: centered greeting,
 * composer, shortcut pills and the market-hours strip.
 *
 * The platform's composer also carries attachment, mode and voice controls.
 * They are omitted rather than rendered inert — this app has no backend for
 * any of them, and dead controls on the page's primary element would mislead.
 */
export function DashboardPage() {
  const navigate = useNavigate()
  const [input, setInput] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const question = input.trim()
    if (!question) return
    // ChatPage picks this up from location state and sends it once on mount.
    navigate('/chats', { state: { initialMessage: question } })
  }

  return (
    <div className="relative h-full">
      {/* Calendar affordance, matching the platform's collapsed widget. This app
          has no events API, so it is a placeholder: no count badge, no expand. */}
      <div className="absolute right-4 top-4 z-10 hidden lg:block">
        <button
          type="button"
          data-testid="dashboard-calendar-collapsed"
          title="Calendar — not available yet"
          aria-label="Calendar — not available yet"
          disabled
          className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-border/50 bg-card text-muted-foreground shadow-card opacity-60"
        >
          <CalendarDays className="h-4 w-4" />
        </button>
      </div>

      <div className="flex h-full flex-col items-center justify-center">
        <div className="mb-8 flex items-center justify-center gap-3">
          <img src="/brand/aion-symbol-mint.svg" alt="AION" className="h-8 w-auto" />
          <h1 className="font-serif text-3xl tracking-tight text-foreground/90 md:text-4xl">
            {getGreetingHeadline()}, {getFirstName()}
          </h1>
        </div>

        <form onSubmit={submit} className="w-full max-w-2xl px-4">
          <div className="relative rounded-2xl border border-border/50 bg-surface-2 px-3 pb-2 pt-3 transition-colors focus-within:border-border">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit(e as unknown as FormEvent)
                }
              }}
              placeholder="Ask about the data, test a factor, or run a backtest"
              rows={2}
              className="max-h-[40vh] min-h-[56px] resize-none overflow-y-auto border-0 bg-transparent px-1 py-0 text-base leading-6 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <div className="mt-1 flex items-center justify-end">
              <Button
                type="submit"
                size="icon"
                aria-label="Send message"
                className="btn-press h-9 w-9 rounded-xl bg-primary text-primary-foreground transition-all duration-200 hover:bg-primary/90"
                disabled={!input.trim()}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </form>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2 px-4">
          {HOME_SHORTCUTS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => navigate(item.route)}
              className="flex items-center gap-1.5 rounded-full border border-border/50 bg-surface-2 px-3.5 py-1.5 text-sm font-medium text-foreground/80 transition-colors hover:bg-surface-3 hover:text-foreground"
            >
              <item.icon className="h-4 w-4 text-muted-foreground" />
              {item.label}
            </button>
          ))}
        </div>

        <div className="mt-4 hidden w-full max-w-2xl px-4 sm:block">
          <MarketHoursWidget />
        </div>
      </div>
    </div>
  )
}
