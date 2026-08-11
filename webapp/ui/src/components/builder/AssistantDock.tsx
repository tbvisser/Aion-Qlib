/**
 * The strategy assistant, docked beside the builder.
 *
 * It talks to the same SSE tool loop as the Chat page, on the `builder` profile
 * — which has no tool that saves or runs anything. So the only way a proposal
 * reaches the form is the Apply button on its card, and that is a deliberate
 * property of the surface rather than a promise in a prompt.
 *
 * The current spec is sent as context on every turn and never appended to the
 * transcript, so the model always sees what is actually on screen rather than
 * what was there three turns ago.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, Bot, PanelRightClose, Square } from 'lucide-react'

import { ProposalCard } from './ProposalCard'
import { ToolCard } from '@/components/chat/ToolCard'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useChatStream } from '@/hooks/useChatStream'
import type { FeatureMode, StrategySpec } from '@/lib/api'
import type { FeatureDraft } from '@/lib/factorExpr/featureSet'
import { isProposal, type BuilderContext, type Proposal } from '@/lib/chat'
// Shared with the front door rather than duplicated. Both are the same offer on
// the same screen, and two arrays is how they end up giving different advice.
import { EXAMPLES } from '@/lib/startHere'
import { cn } from '@/lib/utils'

interface Props {
  spec: StrategySpec
  strategyId?: string
  mode: 'form' | 'canvas'
  /** The column being edited, so "this expression" has a referent. */
  expression?: string
  /** The whole feature set, so it can talk about what it cannot see one at a time. */
  features?: FeatureDraft[]
  featureMode?: FeatureMode
  onApply: (spec: StrategySpec) => void
  onClose: () => void
}

export function AssistantDock({
  spec, strategyId, mode, expression, features, featureMode, onApply, onClose,
}: Props) {
  const [input, setInput] = useState('')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const endRef = useRef<HTMLDivElement>(null)

  // Read through a ref so `context` stays referentially stable: the stream hook
  // memoises on it, and a new function every render would rebuild `send` every
  // keystroke.
  const live = useRef({ spec, strategyId, mode, expression, features, featureMode })
  live.current = { spec, strategyId, mode, expression, features, featureMode }

  // The last proposal the user actually applied, so "why 50 positions?" is
  // answerable next turn. A ref rather than state for the same reason as above.
  const lastApplied = useRef<Proposal | null>(null)

  const context = useCallback((): BuilderContext => {
    const spec = live.current.spec as unknown as Record<string, unknown>
    return {
      spec: live.current.spec,
      strategy_id: live.current.strategyId ?? null,
      saved: Boolean(live.current.strategyId),
      mode: live.current.mode,
      expression: live.current.mode === 'canvas' ? live.current.expression ?? null : null,
      features: (live.current.features ?? []).map((f) => ({
        name: f.name, expression: f.expression, complete: f.complete,
      })),
      feature_mode: live.current.featureMode ?? null,
      // Only the rows still true of what is on screen. Hand-editing topk after
      // applying makes its assumed row a lie, and the model would otherwise be
      // told "topk=50, filled in rather than chosen" beside a form saying 20.
      assumed: lastApplied.current?.assumed.filter(
        (a) => JSON.stringify(spec[a.path]) === JSON.stringify(a.value)) ?? null,
    }
  }, [])

  const { messages, streaming, error, send, stop } = useChatStream({
    profile: 'builder', context,
  })

  useEffect(() => {
    fetch('/api/chat/config?profile=builder')
      .then((r) => r.json())
      .then((c) => setConfigured(Boolean(c.configured)))
      .catch(() => setConfigured(false))
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  const submit = () => {
    if (!input.trim() || streaming) return
    void send(input)
    setInput('')
  }

  return (
    <aside
      data-testid="assistant-dock"
      className="flex min-h-0 w-[380px] shrink-0 flex-col border-l border-border/50"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Assistant</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          proposes only
        </span>
        <Button variant="ghost" size="icon" onClick={onClose} className="ml-auto"
                title="Hide the assistant">
          <PanelRightClose className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {configured === false && (
          <p className="rounded-lg border border-clay/50 p-3 text-[11px] leading-relaxed text-muted-foreground">
            No OpenRouter key is set, so the assistant cannot answer. Add
            <span className="font-mono"> OPENROUTER_API_KEY </span>
            to <span className="font-mono">webapp/.env</span> and restart the API.
          </p>
        )}

        {messages.length === 0 && configured !== false && (
          <div className="space-y-2">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Describe the strategy you want, or ask for a change to the one on screen.
              Every answer is a proposal — nothing is applied or run until you say so.
            </p>
            {EXAMPLES.map((s) => (
              <button
                key={s}
                onClick={() => void send(s)}
                className="block w-full rounded-md border border-border/50 px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-foreground/[0.04]"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={cn('flex', m.role === 'user' && 'justify-end')}>
            {m.role === 'user' ? (
              <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-2 text-[13px] text-accent-foreground">
                {m.content}
              </div>
            ) : (
              <div className="w-full space-y-2">
                {m.tools?.map((t, j) => {
                  // Keyed on the tool-call id rather than a position. The old
                  // `${i}-${j}` key moved whenever the message list shifted, so
                  // an applied proposal could re-key onto a different one.
                  const key = t.id || `${i}-${j}`
                  if (t.name === 'propose_strategy' && isProposal(t.result)
                      && !dismissed.has(key)) {
                    return (
                      <ProposalCard
                        key={key}
                        proposal={t.result as Proposal}
                        current={spec}
                        applied={applied.has(key)}
                        onApply={() => {
                          const proposal = t.result as Proposal
                          lastApplied.current = proposal
                          onApply(proposal.spec as unknown as StrategySpec)
                          setApplied((prev) => new Set(prev).add(key))
                        }}
                        onDismiss={() => setDismissed((prev) => new Set(prev).add(key))}
                      />
                    )
                  }
                  return <ToolCard key={key} tool={t} />
                })}
                {m.content ? (
                  <div className="prose prose-sm max-w-none text-[13px] dark:prose-invert">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                ) : (
                  streaming && (
                    <div className="animate-subtle-pulse text-[13px] text-muted-foreground">
                      Thinking…
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        ))}

        {error && (
          <p className="rounded-lg border border-destructive/40 p-3 font-mono text-[11px] text-destructive">
            {error}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-border/50 p-2">
        <div className="flex items-end gap-2">
          <Textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="Describe a strategy…"
            disabled={configured === false}
            className="min-h-0 resize-none text-[13px]"
          />
          {streaming ? (
            <Button size="icon" variant="outline" onClick={stop} title="Stop">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button size="icon" onClick={submit}
                    disabled={!input.trim() || configured === false}>
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </aside>
  )
}
