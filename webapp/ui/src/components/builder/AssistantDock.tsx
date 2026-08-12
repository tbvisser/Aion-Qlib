/**
 * The strategy assistant, docked beside the builder.
 *
 * It talks to the same SSE tool loop as the Chat page, on the `builder` profile
 * — which has no tool that saves or runs anything. So the only way a proposal
 * reaches the canvas is the button on its card, and that is a deliberate
 * property of the surface rather than a promise in a prompt.
 *
 * The conversation itself is the page's (`useBuilderChat`), shared with the
 * front door. That is what lets you describe a strategy, use it, and then keep
 * talking about it here — before, each surface had its own stream and applying
 * a proposal destroyed the front door's half of the history.
 *
 * The current spec is sent as context on every turn and never appended to the
 * transcript, so the model always sees what is actually on screen rather than
 * what was there three turns ago.
 */
import { useState } from 'react'
import { Bot, PanelRightClose } from 'lucide-react'

import { ChatComposer, ChatTranscript } from './ChatTranscript'
import { Button } from '@/components/ui/button'
import type { BuilderChat } from '@/hooks/useBuilderChat'
import type { StrategySpec } from '@/lib/api'
// Shared with the front door rather than duplicated. Both are the same offer on
// the same screen, and two arrays is how they end up giving different advice.
import { EXAMPLES } from '@/lib/startHere'

interface Props {
  /** The page's conversation, shared with the front door. */
  chat: BuilderChat
  /** null while the deployment's chat config is still being fetched. */
  configured: boolean | null
  spec: StrategySpec
  onApply: (spec: StrategySpec) => void
  onClose: () => void
}

export function AssistantDock({ chat, configured, spec, onApply, onClose }: Props) {
  const [input, setInput] = useState('')
  const { messages, streaming, send, stop } = chat

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

        <ChatTranscript chat={chat} spec={spec} onApply={onApply} />
      </div>

      <div className="shrink-0 border-t border-border/50 p-2">
        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={submit}
          onStop={stop}
          streaming={streaming}
          disabled={configured === false}
          placeholder="Describe a strategy…"
        />
      </div>
    </aside>
  )
}
