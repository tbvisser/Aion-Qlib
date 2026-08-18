/**
 * One keycard conversation, owned by the Keycard Builder page.
 *
 * Mirrors useBuilderChat: one history shared by the front door and the docked
 * assistant, so applying a proposal does not destroy the transcript. The
 * current KeycardSpec is read through a ref and sent as context on every turn.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useChatStream } from '@/hooks/useChatStream'
import { authHeaders } from '@/lib/authFetch'
import type { KeycardSpec } from '@/lib/api'
import type { ChatMessage, KeycardContext, Proposal } from '@/lib/chat'
import { readModelConfig } from '@/features/rag/hooks/useModelConfig'

/** What the keycard builder has on screen. Read through a ref, so it is never a dependency. */
export interface KeycardChatState {
  spec: KeycardSpec
  keycardId?: string
}

export interface KeycardChat {
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

export function useKeycardChat(state: KeycardChatState): KeycardChat {
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  const live = useRef(state)
  live.current = state

  const lastApplied = useRef<Proposal | null>(null)

  const context = useCallback((): KeycardContext => {
    const spec = live.current.spec as unknown as Record<string, unknown>
    return {
      spec: live.current.spec,
      keycard_id: live.current.keycardId ?? null,
      saved: Boolean(live.current.keycardId),
      assumed: lastApplied.current?.assumed.filter(
        (a) => JSON.stringify(spec[a.path]) === JSON.stringify(a.value)) ?? null,
    }
  }, [])

  const { messages, streaming, error, send, stop } = useChatStream({
    profile: 'keycard-builder', context,
  })

  const sendWithModel = useCallback(async (text: string) => {
    const cfg = readModelConfig()
    await send(text, { model: cfg.model || undefined })
  }, [send])

  const markApplied = useCallback((key: string, proposal: Proposal) => {
    lastApplied.current = proposal
    setApplied((prev) => new Set(prev).add(key))
  }, [])

  const markDismissed = useCallback((key: string) => {
    setDismissed((prev) => new Set(prev).add(key))
  }, [])

  return useMemo(
    () => ({ messages, streaming, error, send: sendWithModel, stop, applied, dismissed,
             markApplied, markDismissed }),
    [messages, streaming, error, sendWithModel, stop, applied, dismissed, markApplied, markDismissed],
  )
}

/**
 * Whether the keycard chat backend is usable at all.
 *
 * Separate from the conversation because it is a property of the deployment,
 * fetched once, and both surfaces need it to decide whether to offer a composer
 * or explain why there isn't one.
 */
export function useKeycardChatConfigured(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void authHeaders()
      .then((h) => fetch('/api/chat/config?profile=keycard-builder', { headers: h }))
      .then((r) => r.json())
      .then((c) => { if (!cancelled) setConfigured(Boolean(c.configured)) })
      .catch(() => { if (!cancelled) setConfigured(false) })
    return () => { cancelled = true }
  }, [])

  return configured
}
