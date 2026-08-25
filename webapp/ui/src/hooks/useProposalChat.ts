/**
 * The machinery both builder assistants share.
 *
 * `useBuilderChat` and `useKeycardChat` were near line-for-line copies: the
 * same applied/dismissed bookkeeping, the same last-applied ref feeding the
 * `assumed` filter, the same memoised return. Only the context each sends is
 * its own — so the context is the parameter and everything else lives here
 * once.
 *
 * The applied/dismissed sets are keyed on tool-call id, so a proposal marked
 * applied in one surface still reads as applied in another rendering the same
 * conversation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useChatStream } from '@/hooks/useChatStream'
import { authHeaders } from '@/lib/authFetch'
import type {
  BuilderContext, ChatMessage, ChatProfile, KeycardContext, Proposal,
} from '@/lib/chat'

export interface ProposalChat {
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

export function useProposalChat<C extends BuilderContext | KeycardContext>(opts: {
  profile: ChatProfile
  /**
   * What the model is told about the screen, rebuilt on every send. Receives
   * the last proposal the user applied, so "why 50 positions?" is answerable
   * next turn. Read through a ref internally — passing a fresh arrow function
   * every render is fine and costs nothing.
   */
  buildContext: (lastApplied: Proposal | null) => C
  /** Per-send options, e.g. a model override read at send time. */
  sendOptions?: () => { model?: string } | undefined
}): ProposalChat {
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const lastApplied = useRef<Proposal | null>(null)

  // Refs so `context` and `send` stay referentially stable: the stream hook
  // memoises on them, and a new function every render would rebuild `send`
  // every keystroke.
  const build = useRef(opts.buildContext)
  build.current = opts.buildContext
  const perSend = useRef(opts.sendOptions)
  perSend.current = opts.sendOptions

  const context = useCallback(() => build.current(lastApplied.current), [])

  const { messages, streaming, error, send: rawSend, stop } = useChatStream({
    profile: opts.profile, context,
  })

  const send = useCallback(async (text: string) => {
    await rawSend(text, perSend.current?.())
  }, [rawSend])

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
 * Whether the chat backend is usable at all, for one profile.
 *
 * Separate from the conversation because it is a property of the deployment,
 * fetched once, and the surfaces need it to decide whether to offer a composer
 * or explain why there isn't one.
 */
export function useProfileConfigured(profile: string): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void authHeaders()
      .then((h) => fetch(`/api/chat/config?profile=${profile}`, { headers: h }))
      .then((r) => r.json())
      .then((c) => { if (!cancelled) setConfigured(Boolean(c.configured)) })
      // A failure is "cannot answer", not "unknown": the surfaces use `null`
      // to mean "still asking" and would otherwise offer a composer forever.
      .catch(() => { if (!cancelled) setConfigured(false) })
    return () => { cancelled = true }
  }, [profile])

  return configured
}
