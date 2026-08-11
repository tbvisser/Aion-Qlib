/**
 * The Strategy Builder's front door.
 *
 * The two ways into a strategy that do not require knowing the vocabulary —
 * describe it, or pick a card — were both real and both hidden: the assistant
 * behind a header toggle that is off by default, and the templates behind the
 * rail's second tab. An empty builder therefore opened on nineteen labelled
 * controls, which is a form for someone who already knows what they want.
 *
 * Nothing here is a new capability. The describe half is one turn through the
 * same `builder` chat profile the dock uses, rendered with the same
 * `ProposalCard`; the cards are the same `TemplateDetail` the rail opens. This
 * is a placement change, and it is deliberately built out of the existing parts
 * so there is no second proposal renderer to keep in step.
 *
 * **It cannot run anything.** `PROFILES["builder"]` has no `run_backtest` tool,
 * and a proposal reaches the form only through the card's Apply button. Moving
 * the entrance forward must not move that line.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Square, X } from 'lucide-react'

import { ProposalCard } from './ProposalCard'
import { TemplateDetail } from './TemplateRail'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useChatStream } from '@/hooks/useChatStream'
import { useTemplates } from '@/hooks/useTemplates'
import type { StrategySpec, TemplateEntry } from '@/lib/api'
import { isProposal, type BuilderContext, type Proposal } from '@/lib/chat'
import { EXAMPLES, pickStarters } from '@/lib/startHere'
import { cn } from '@/lib/utils'

/** Four fits one row at `xl` and two at `sm` without a third breakpoint. */
const STARTERS = 4

export function StartHere({ spec, onApply, onDismiss }: {
  /** Sent as context so "make this more conservative" has a referent. */
  spec: StrategySpec
  onApply: (spec: StrategySpec) => void
  onDismiss: () => void
}) {
  const [input, setInput] = useState('')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const { data } = useTemplates()

  // Same ref indirection as the dock: `useChatStream` memoises on `context`,
  // and a fresh closure every render would rebuild `send` on every keystroke.
  const live = useRef(spec)
  live.current = spec

  const context = useCallback((): BuilderContext => ({
    spec: live.current,
    strategy_id: null,
    saved: false,
    mode: 'form',
    expression: null,
    features: [],
    feature_mode: live.current.feature_mode ?? null,
    assumed: null,
  }), [])

  const { messages, streaming, error, send, stop } = useChatStream({
    profile: 'builder', context,
  })

  useEffect(() => {
    fetch('/api/chat/config?profile=builder')
      .then((r) => r.json())
      .then((c) => setConfigured(Boolean(c.configured)))
      .catch(() => setConfigured(false))
  }, [])

  const submit = (text: string) => {
    if (!text.trim() || streaming) return
    void send(text)
    setInput('')
  }

  // Only the newest one. This panel is a doorway, not a conversation — a
  // second proposal below the first invites comparing them here, which is what
  // the dock is for and what this has no room to do well.
  const proposal = latestProposal(messages)
  const starters = pickStarters(data?.templates ?? [], STARTERS)
  const familyLabel = (key: string) =>
    data?.families.find((f) => f.key === key)?.label ?? key

  return (
    <Panel
      data-testid="start-here"
      title="Start here"
      hint="or fill in the form below"
      actions={
        <button
          onClick={onDismiss}
          title="Hide this — I'll fill in the form myself"
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
          <p className="rounded-lg border border-clay/50 p-3 text-[12px] leading-relaxed text-muted-foreground">
            Describing a strategy in words needs an OpenRouter key. Add
            <span className="font-mono"> OPENROUTER_API_KEY </span>
            to <span className="font-mono">webapp/.env</span> and restart the API.
            The cards below work either way.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-[13px] leading-relaxed">
              Describe what you want to trade. You get a proposal to look over —
              nothing is saved or run until you apply it.
            </p>

            <div className="flex items-end gap-2">
              <Textarea
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    submit(input)
                  }
                }}
                placeholder="momentum on US large caps, low turnover…"
                data-testid="start-here-input"
                className="min-h-0 resize-none text-[13px]"
              />
              {streaming ? (
                <Button size="icon" variant="outline" onClick={stop} title="Stop">
                  <Square className="h-4 w-4" />
                </Button>
              ) : (
                <Button size="icon" onClick={() => submit(input)} disabled={!input.trim()}
                        title="Describe it">
                  <ArrowUp className="h-4 w-4" />
                </Button>
              )}
            </div>

            {!messages.length && (
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    onClick={() => submit(example)}
                    className="rounded-md border border-border/50 px-2 py-1 text-[11px] transition-colors hover:bg-foreground/[0.04]"
                  >
                    {example}
                  </button>
                ))}
              </div>
            )}

            {streaming && !proposal && (
              <p className="animate-subtle-pulse text-[12px] text-muted-foreground">
                Working out a strategy…
              </p>
            )}

            {error && (
              <p className="rounded-lg border border-destructive/40 p-2 font-mono text-[11px] text-destructive">
                {error}
              </p>
            )}

            {proposal && (
              <ProposalCard
                proposal={proposal}
                current={spec}
                applied={false}
                onApply={() => {
                  onApply(proposal.spec as unknown as StrategySpec)
                  onDismiss()
                }}
                onDismiss={onDismiss}
              />
            )}
          </div>
        )}

        {starters.length > 0 && (
          <div className="space-y-2 border-t border-border/50 pt-3">
            <p className="text-[12px] text-muted-foreground">
              …or start from one of these and change it:
            </p>
            {/* Two columns, never four. This panel sits in the form's left
                column, which is ~460px at the widest — four cards across put
                a title into ~100px and it collided with its own badge. */}
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

/**
 * One card.
 *
 * Clicking opens `TemplateDetail` — the rail's popover, unchanged — rather than
 * applying immediately. What a template is bad at, and why it cannot run here,
 * are written in there, and a card that applies on first click is a card whose
 * caveats nobody reads.
 */
function StarterCard({ template, familyLabel, onUse }: {
  template: TemplateEntry
  familyLabel: string
  onUse: () => void
}) {
  const [open, setOpen] = useState(false)
  const dead = !template.runnable

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-testid={`starter-${template.id}`}
          onClick={() => setOpen(true)}
          // Not `disabled`: an unrunnable card must still open, because the
          // popover is the only place its reasons are written down.
          className={cn(
            'flex h-full flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors',
            dead
              ? 'border-clay/40 hover:bg-clay/[0.06]'
              : 'border-border/50 hover:bg-foreground/[0.04]',
          )}
        >
          {/* The family label leads on its own line rather than sharing one
              with the title. Side by side, a `shrink-0` badge takes its width
              out of the title's before the title gets a say — which at this
              card size left the title with none. */}
          <Badge variant={dead ? 'clay' : 'muted'} className="self-start">{familyLabel}</Badge>
          <span className="text-[13px] font-medium leading-snug">{template.title}</span>
          <p className="line-clamp-3 text-[11px] leading-snug text-muted-foreground">
            {dead ? template.blocked_by[0]?.message ?? 'Cannot run here.' : template.rationale}
          </p>
        </button>
      </PopoverTrigger>

      <PopoverContent side="bottom" align="start" className="w-96 p-3">
        <TemplateDetail
          template={template}
          onUse={() => {
            onUse()
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** The newest `propose_strategy` result across the transcript, if any. */
function latestProposal(messages: { tools?: { name: string; result?: unknown }[] }[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const tools = messages[i].tools ?? []
    for (let j = tools.length - 1; j >= 0; j -= 1) {
      const tool = tools[j]
      if (tool.name === 'propose_strategy' && isProposal(tool.result)) {
        return tool.result as Proposal
      }
    }
  }
  return null
}
