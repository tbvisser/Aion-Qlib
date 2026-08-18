/**
 * The keycard assistant, docked beside the Keycard Builder.
 *
 * It talks to the same SSE tool loop as the Chat page, on the `keycard-builder`
 * profile — which has no tool that saves or runs anything. Proposals only reach
 * the canvas when the user presses the button on a card.
 *
 * The conversation itself is the page's (`useKeycardChat`), shared with the
 * front door. The current spec is sent as context on every turn and never
 * appended to the transcript, so the model always sees what is actually on
 * screen rather than what was there three turns ago.
 */
import { useState } from 'react'
import { ArrowUp, Check, PanelRightClose, Square, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { KeycardChat } from '@/hooks/useKeycardChat'
import type { KeycardSpec } from '@/lib/api'
import { isProposal, type Proposal } from '@/lib/chat'
import { cn } from '@/lib/utils'

interface Props {
  /** The page's conversation, shared with the front door. */
  chat: KeycardChat
  /** null while the deployment's chat config is still being fetched. */
  configured: boolean | null
  spec: KeycardSpec
  onApply: (spec: KeycardSpec) => void
  onClose: () => void
}

const EXAMPLES = [
  'Build an opening-range breakout keycard',
  'Add a stop-loss rule to my keycard',
  'Make this keycard trade only on daily candles',
]

export function KeycardAssistantDock({ chat, configured, spec, onApply, onClose }: Props) {
  const [input, setInput] = useState('')
  const { messages, streaming, send, stop, applied, dismissed, markApplied, markDismissed } = chat

  const submit = () => {
    if (!input.trim() || streaming) return
    void send(input)
    setInput('')
  }

  return (
    <div
      data-testid="keycard-assistant-dock"
      className="flex min-h-0 w-full shrink-0 flex-col"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border/50 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">SANA</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            proposes only
          </span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} title="Hide SANA">
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
              Describe the keycard you want, or ask for a change to the one on screen.
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
              <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-2 text-sm text-accent-foreground">
                {m.content}
              </div>
            ) : (
              <div className="w-full space-y-3">
                {m.tools?.map((t, j) => {
                  const key = t.id || `${i}-${j}`
                  if (t.name === 'propose_keycard' && isProposal(t.result)
                      && !dismissed.has(key)) {
                    return (
                      <KeycardProposalCard
                        key={key}
                        proposal={t.result as Proposal}
                        current={spec}
                        applied={applied.has(key)}
                        onApply={() => {
                          const proposal = t.result as Proposal
                          markApplied(key, proposal)
                          onApply(proposal.spec as unknown as KeycardSpec)
                        }}
                        onDismiss={() => markDismissed(key)}
                      />
                    )
                  }
                  return (
                    <div key={key} className="rounded-lg border border-border/50 p-2">
                      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                        {t.name}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {t.result && typeof t.result === 'object' && 'error' in t.result
                          ? String((t.result as { error: unknown }).error)
                          : 'Done'}
                      </p>
                    </div>
                  )
                })}
                {m.content ? (
                  <div className="text-sm text-foreground">{m.content}</div>
                ) : (
                  streaming && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span className="animate-subtle-pulse">Thinking…</span>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-border/50 bg-card/30 p-4">
        <div className="flex items-end gap-2 rounded-xl border border-border/50 bg-card p-2 focus-glow">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={configured === false ? 'SANA not configured' : 'Describe a keycard…'}
            disabled={configured === false || streaming}
            rows={1}
            className="min-h-[40px] resize-none border-0 bg-transparent text-sm focus-visible:ring-0"
          />
          {streaming ? (
            <Button size="icon" variant="outline" onClick={stop} title="Stop">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={submit}
              disabled={!input.trim() || configured === false}
              title="Send"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function KeycardProposalCard({
  proposal,
  current,
  applied,
  onApply,
  onDismiss,
}: {
  proposal: Proposal
  current: KeycardSpec
  applied: boolean
  onApply: () => void
  onDismiss: () => void
}) {
  const spec = proposal.spec as unknown as KeycardSpec
  const nodeDelta = spec.nodes.length - current.nodes.length
  const edgeDelta = spec.edges.length - current.edges.length

  return (
    <div
      data-testid="keycard-proposal-card"
      className={cn('overflow-hidden rounded-lg border bg-card',
                    applied ? 'border-primary/40' : 'border-border/50')}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          Proposed keycard
        </span>
        {proposal.source.startsWith('template:') && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
            {proposal.source.replace('template:', '')}
          </span>
        )}
        <span className="ml-auto font-mono text-xs">{spec.name || 'Untitled'}</span>
      </div>

      <div className="space-y-3 p-3">
        <p className="text-[11px] text-muted-foreground">
          {nodeDelta === 0 && edgeDelta === 0
            ? 'Same shape as the current keycard.'
            : `${nodeDelta >= 0 ? `+${nodeDelta}` : nodeDelta} block${Math.abs(nodeDelta) === 1 ? '' : 's'}, ${edgeDelta >= 0 ? `+${edgeDelta}` : edgeDelta} connection${Math.abs(edgeDelta) === 1 ? '' : 's'}`}
        </p>

        {proposal.assumed.length > 0 && (
          <div>
            <div className="pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              Assumed — nobody stated {proposal.assumed.length === 1 ? 'this' : 'these'}
            </div>
            {proposal.assumed.slice(0, 3).map((a) => (
              <div key={a.path} className="py-0.5">
                <span className="font-mono text-[11px]">{a.path}={JSON.stringify(a.value)}</span>
                {a.why && <span className="ml-2 text-[11px] text-muted-foreground">{a.why}</span>}
              </div>
            ))}
            {proposal.assumed.length > 3 && (
              <p className="text-[11px] text-muted-foreground">
                and {proposal.assumed.length - 3} more
              </p>
            )}
          </div>
        )}

        {proposal.warnings.map((w) => (
          <p key={w} className="text-[11px] leading-relaxed text-clay">{w}</p>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-border/50 px-3 py-2">
        {applied ? (
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-primary">
            <Check className="h-3.5 w-3.5" />
            On the canvas
          </span>
        ) : (
          <>
            <Button size="sm" onClick={onApply} data-testid="keycard-proposal-apply">
              <Check className="h-4 w-4" />
              Add to canvas
            </Button>
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              <X className="h-4 w-4" />
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
