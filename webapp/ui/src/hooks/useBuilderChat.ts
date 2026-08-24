/**
 * One builder conversation, owned by the page.
 *
 * The front door and the docked assistant used to hold a `useChatStream` each.
 * That made them two conversations that could not see one another, and — worse
 * — the front door unmounts the moment a proposal is applied, so describing a
 * strategy and using it *destroyed the transcript*. You could not then say
 * "make it lower turnover", because nothing remembered what you had asked for.
 *
 * Lifting the hook here fixes both: one history, two views of it, and applying
 * a proposal is no longer an act of forgetting.
 *
 * The applied/dismissed sets live here for the same reason. They are keyed on
 * tool-call id, so a proposal marked applied in the front door still reads as
 * applied in the dock.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useChatStream } from '@/hooks/useChatStream'
import { authHeaders } from '@/lib/authFetch'
import type { FeatureMode, StrategySpec } from '@/lib/api'
import type { ChatMessage, BuilderContext, Proposal } from '@/lib/chat'
import type { FeatureDraft } from '@/lib/factorExpr/featureSet'

/** What the builder has on screen. Read through a ref, so it is never a dependency. */
export interface BuilderChatState {
  spec: StrategySpec
  strategyId?: string
  /** The chat API's vocabulary, not the page's — `BuilderContext.mode` is a Literal. */
  mode: 'form' | 'canvas'
  expression?: string
  features?: FeatureDraft[]
  featureMode?: FeatureMode
}

export interface BuilderChat {
  messages: ChatMessage[]
  streaming: boolean
  error: string | null
  send: (text: string) => Promise<void>
  stop: () => void
  /** Tool-call ids of proposals already used. */
  applied: Set<string>
  /** Tool-call ids the user rejected. */
  dismissed: Set<string>
  markApplied: (key: string, proposal: Proposal) => void
  markDismissed: (key: string) => void
}

export function useBuilderChat(state: BuilderChatState): BuilderChat {
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  // Read through a ref so `context` stays referentially stable: the stream hook
  // memoises on it, and a new function every render would rebuild `send` every
  // keystroke.
  const live = useRef(state)
  live.current = state

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
      // told "topk=50, filled in rather than chosen" beside a canvas saying 20.
      assumed: lastApplied.current?.assumed.filter(
        (a) => JSON.stringify(spec[a.path]) === JSON.stringify(a.value)) ?? null,
      context: live.current.spec.context,
    }
  }, [])

  const { messages, streaming, error, send, stop } = useChatStream({
    profile: 'builder', context,
  })

  const markApplied = useCallback((key: string, proposal: Proposal) => {
    lastApplied.current = proposal
    setApplied((prev) => new Set(prev).add(key))
  }, [])

  const markDismissed = useCallback((key: string) => {
    setDismissed((prev) => new Set(prev).add(key))
  }, [])

  return useMemo(
    () => ({ messages, streaming, error, send, stop, applied, dismissed,
             markApplied, markDismissed }),
    [messages, streaming, error, send, stop, applied, dismissed, markApplied, markDismissed],
  )
}

/**
 * Whether the chat backend is usable at all.
 *
 * Separate from the conversation because it is a property of the deployment,
 * fetched once, and both surfaces need it to decide whether to offer a composer
 * or explain why there isn't one.
 */
export function useChatConfigured(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void authHeaders()
      .then((h) => fetch('/api/chat/config?profile=builder', { headers: h }))
      .then((r) => r.json())
      .then((c) => { if (!cancelled) setConfigured(Boolean(c.configured)) })
      // A failure is "cannot answer", not "unknown": the surfaces use `null`
      // to mean "still asking" and would otherwise offer a composer forever.
      .catch(() => { if (!cancelled) setConfigured(false) })
    return () => { cancelled = true }
  }, [])

  return configured
}
