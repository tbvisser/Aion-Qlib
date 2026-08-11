import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { ToolCard } from '@/components/chat/ToolCard'
import { useChatStream } from '@/hooks/useChatStream'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const SUGGESTIONS = [
  'What data is loaded right now?',
  'Test whether 20-day reversal predicts returns',
  'Run a LightGBM backtest on the top 500 and tell me the IR',
  'Compare NVDA and AMD over the last year',
]

export function ChatPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { messages, streaming, error, send } = useChatStream()
  const [input, setInput] = useState('')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [model, setModel] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/chat/config')
      .then((r) => r.json())
      .then((c) => {
        setConfigured(c.configured)
        setModel(c.model)
      })
      .catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  // A question typed into the home composer arrives as navigation state. Send it
  // once, then clear the state so a refresh or back-navigation doesn't resend it.
  //
  // The ref is load-bearing: clearing router state is asynchronous, so under
  // StrictMode's double-invoked effects the second pass still sees the message
  // and would send it twice. It also covers any future remount.
  const initialMessage = (location.state as { initialMessage?: string } | null)?.initialMessage
  const sentInitial = useRef(false)
  useEffect(() => {
    if (!initialMessage || sentInitial.current) return
    sentInitial.current = true
    navigate(location.pathname, { replace: true, state: null })
    void send(initialMessage)
    // Deliberately keyed on the message alone: `send` is recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage])

  return (
    <>
      <PageHeader
        title="Chat"
        description={
          configured === false
            ? 'Set OPENROUTER_API_KEY in webapp/.env to enable the assistant.'
            : `Ask for analysis — the assistant runs it on the real engine. ${model}`
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          {messages.length === 0 && (
            <div className="space-y-4 pt-8">
              <p className="text-center text-sm text-muted-foreground">
                The assistant can query data, measure factors and launch backtests.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    disabled={configured === false}
                    className="rounded-lg border border-border/50 px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={cn('animate-fade-in', m.role === 'user' && 'flex justify-end')}>
              {m.role === 'user' ? (
                <div className="max-w-[85%] rounded-2xl bg-accent px-4 py-2.5 text-sm text-accent-foreground">
                  {m.content}
                </div>
              ) : (
                <div className="space-y-2">
                  {m.tools?.map((t, j) => <ToolCard key={j} tool={t} />)}
                  {m.content ? (
                    <div className="prose prose-sm max-w-none dark:prose-invert">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  ) : (
                    streaming && (
                      <div className="animate-subtle-pulse text-sm text-muted-foreground">
                        Thinking…
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          ))}

          {error && (
            <Card className="border-destructive/40">
              <CardContent className="p-3 font-mono text-xs text-destructive">{error}</CardContent>
            </Card>
          )}

          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-border/50 p-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-border/50 bg-card p-2 focus-glow">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(input)
                setInput('')
              }
            }}
            placeholder={configured === false ? 'Assistant not configured' : 'Ask about the data, a factor, or a strategy…'}
            disabled={configured === false || streaming}
            rows={1}
            className="min-h-[40px] resize-none border-0 bg-transparent focus-visible:ring-0"
          />
          <Button
            size="icon"
            onClick={() => { void send(input); setInput('') }}
            disabled={!input.trim() || streaming || configured === false}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  )
}

