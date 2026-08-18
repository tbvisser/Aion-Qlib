/**
 * The builder conversation, drawn.
 *
 * Extracted from `AssistantDock` when the front door became a conversation
 * too. The front door previously rendered *nothing* from the transcript — it
 * cleared the textarea on submit and mined the stream for the newest
 * `propose_strategy` result — so your own words vanished, the model's
 * explanation was never shown, and a second proposal replaced the first with no
 * record that either had happened.
 *
 * Both surfaces render this now, so there is one answer to "what does an
 * in-flight turn look like" rather than two that drift.
 */
import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, Square } from 'lucide-react'

import { AionMark } from '@/components/AionMark'
import { ProposalCard } from './ProposalCard'
import { ToolCard } from '@/components/chat/ToolCard'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { StrategySpec } from '@/lib/api'
import { isProposal, type Proposal } from '@/lib/chat'
import type { BuilderChat } from '@/hooks/useBuilderChat'
import { cn } from '@/lib/utils'

export function ChatTranscript({ chat, spec, onApply, primaryLabel, className }: {
  chat: BuilderChat
  /** The strategy on screen, for the proposal's change list. */
  spec: StrategySpec
  onApply: (spec: StrategySpec) => void
  /** The proposal card's primary button. Differs between the two surfaces. */
  primaryLabel?: string
  className?: string
}) {
  const { messages, streaming, error, applied, dismissed, markApplied, markDismissed } = chat
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  return (
    <div className={cn('space-y-4', className)}>
      {messages.map((m, i) => (
        <div key={i} className={cn('flex', m.role === 'user' && 'justify-end')}>
          {m.role === 'user' ? (
            <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-2 text-sm text-accent-foreground">
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
                      primaryLabel={primaryLabel}
                      onApply={() => {
                        const proposal = t.result as Proposal
                        markApplied(key, proposal)
                        onApply(proposal.spec as unknown as StrategySpec)
                      }}
                      onDismiss={() => markDismissed(key)}
                    />
                  )
                }
                return <ToolCard key={key} tool={t} />
              })}
              {m.content ? (
                <div className="prose prose-sm max-w-none text-sm dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                </div>
              ) : (
                // The mark, not a spinner and not a bare string: what is
                // thinking is AION, and the reader should be able to tell at a
                // glance that something is happening rather than read that it is.
                streaming && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <AionMark thinking alt="" className="h-4" />
                    <span className="animate-subtle-pulse">Thinking…</span>
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
  )
}

/**
 * The composer both surfaces share.
 *
 * Enter sends, Shift+Enter newlines, and the send button becomes Stop while a
 * turn is in flight — identical in the dock and the front door, because they
 * are the same control and a keystroke that means two things is a bug.
 */
export function ChatComposer({
  value, onChange, onSubmit, onStop, streaming, disabled, placeholder, rows = 1,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onStop: () => void
  streaming: boolean
  disabled?: boolean
  placeholder: string
  rows?: number
}) {
  return (
    <div className="flex items-end gap-2">
      <Textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSubmit()
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        data-testid="builder-chat-input"
        className="min-h-0 resize-none text-sm"
      />
      {streaming ? (
        <Button size="icon" variant="outline" onClick={onStop} title="Stop">
          <Square className="h-4 w-4" />
        </Button>
      ) : (
        <Button size="icon" onClick={onSubmit} disabled={!value.trim() || disabled}
                title="Send">
          <ArrowUp className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
