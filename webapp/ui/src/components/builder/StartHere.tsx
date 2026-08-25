/**
 * The Strategy Builder's front door.
 *
 * The two ways into a strategy that do not require knowing the vocabulary —
 * describe it, or pick a card — were both hidden: the assistant behind a header
 * toggle that is off by default, and the templates behind the rail's second tab.
 *
 * It used to be a *doorway* rather than a conversation: it cleared the textarea
 * on submit, rendered nothing from the transcript, and showed only the newest
 * proposal. So your own words vanished the moment you sent them, the model's
 * explanation of what it had decided was never shown, and applying tore the
 * panel down and took the history with it — which made "make it lower turnover"
 * impossible to say. It renders the shared `ChatTranscript` now, over a
 * conversation the page owns, so the history outlives this panel.
 *
 * **It still cannot run anything.** `PROFILES["builder"]` has no `run_backtest`
 * tool, and a proposal reaches the canvas only through the card's button.
 * Moving the entrance forward must not move that line.
 */
import { useState } from 'react'
import { X } from 'lucide-react'

import { ChatComposer, ChatTranscript } from './ChatTranscript'
import { TemplateDetail } from './TemplateRail'
import { AionMark } from '@/components/AionMark'
import { Badge } from '@/components/ui/badge'
import { MicroLabel } from '@/components/ui/micro-label'
import { Panel } from '@/components/ui/panel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { BuilderChat } from '@/hooks/useBuilderChat'
import { useTemplates } from '@/hooks/useTemplates'
import type { StrategySpec, TemplateEntry } from '@/lib/api'
import { EXAMPLES, pickStarters } from '@/lib/startHere'
import { cn } from '@/lib/utils'

/** Four fits one row at `xl` and two at `sm` without a third breakpoint. */
const STARTERS = 4

export function StartHere({ chat, configured, spec, onApply, onDismiss }: {
  /** The page's conversation, shared with the dock. */
  chat: BuilderChat
  /** null while the deployment's chat config is still being fetched. */
  configured: boolean | null
  /** Sent as context so "make this more conservative" has a referent. */
  spec: StrategySpec
  onApply: (spec: StrategySpec) => void
  onDismiss: () => void
}) {
  const [input, setInput] = useState('')
  const { data } = useTemplates()
  const { messages, streaming, send, stop } = chat

  const submit = (text: string) => {
    if (!text.trim() || streaming) return
    void send(text)
    setInput('')
  }

  const started = messages.length > 0
  const starters = pickStarters(data?.templates ?? [], STARTERS)
  const familyLabel = (key: string) =>
    data?.families.find((f) => f.key === key)?.label ?? key

  return (
    <Panel
      data-testid="start-here"
      title="Start here"
      hint={started ? 'ask for a change, or use it' : 'describe it, or pick a card'}
      actions={
        <button
          onClick={onDismiss}
          title="Hide this — I'll build it on the canvas myself"
          className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      }
    >
      <div className="space-y-4">
        {configured === false ? (
          /* Not a disabled textarea. An input you cannot type into explains
             nothing; the cards below still work, and this says why the other
             half does not. */
          <p className="rounded-lg border border-clay/50 p-3 text-caption leading-relaxed text-muted-foreground">
            Describing a strategy in words needs an OpenRouter key. Add
            <span className="font-mono"> OPENROUTER_API_KEY </span>
            to <span className="font-mono">webapp/.env</span> and restart the API.
          </p>
        ) : (
          <div className="space-y-3">
            {!started && (
              <div className="flex items-start gap-2.5">
                <AionMark alt="" className="mt-0.5 h-4" />
                <p className="text-body-sm leading-relaxed">
                  Describe what you want to trade. You get a proposal to look over —
                  nothing is saved or run until you use it.
                </p>
              </div>
            )}

            {started && (
              <ChatTranscript
                chat={chat}
                spec={spec}
                onApply={onApply}
                // From here, applying *is* the point and the canvas is what
                // follows. The dock keeps "Apply", where a proposal is one edit
                // among several to a strategy already on screen.
                primaryLabel="Use this strategy"
                className="max-h-[45vh] overflow-y-auto"
              />
            )}

            <ChatComposer
              rows={2}
              value={input}
              onChange={setInput}
              onSubmit={() => submit(input)}
              onStop={stop}
              streaming={streaming}
              placeholder={started
                ? 'lower the turnover…'
                : 'momentum on US large caps, low turnover…'}
            />

            {!started && (
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    onClick={() => submit(example)}
                    className="rounded-md border border-border/50 px-2 py-1 text-label transition-colors hover:bg-foreground/[0.04]"
                  >
                    {example}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Only before the conversation starts. Once there is a proposal on
            screen, a grid of alternatives underneath it is a second offer
            competing with the one you asked for. */}
        {!started && starters.length > 0 && (
          <div className="space-y-2 border-t border-border/50 pt-3">
            <p className="text-caption text-muted-foreground">
              …or start from one of these and change it:
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {starters.map((template) => (
                <StarterCard
                  key={template.id}
                  template={template}
                  familyLabel={familyLabel(template.family)}
                  onUse={() => {
                    if (!template.spec) return
                    onApply(template.spec)
                    onDismiss()
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  )
}

function StarterCard({ template, familyLabel, onUse }: {
  template: TemplateEntry
  familyLabel: string
  onUse: () => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          data-testid={`starter-${template.id}`}
          className={cn(
            'group flex flex-col gap-1 rounded-lg border border-border/60 bg-surface-2 p-2.5 text-left transition-colors',
            'hover:bg-surface-3',
          )}
        >
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-body-sm">{template.title}</span>
            {!template.runnable && <Badge variant="clay">blocked</Badge>}
          </span>
          <MicroLabel className="truncate">
            {familyLabel}
          </MicroLabel>
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-96 p-3">
        <TemplateDetail template={template} onUse={onUse} />
      </PopoverContent>
    </Popover>
  )
}
