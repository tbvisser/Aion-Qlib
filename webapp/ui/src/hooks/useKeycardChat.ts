/**
 * One keycard conversation, owned by the Keycard Builder page.
 *
 * Mirrors `useBuilderChat` — deliberately, and now literally: both are thin
 * wrappers over `useProposalChat`, which owns the applied/dismissed sets and
 * the last-applied ref. Only the context sent each turn is this hook's own.
 * The current KeycardSpec is read through a ref and sent on every send, so the
 * model always sees what is actually on screen.
 */
import { useRef } from 'react'

import { useProposalChat, useProfileConfigured, type ProposalChat }
  from '@/hooks/useProposalChat'
import type { KeycardSpec } from '@/lib/api'
import type { KeycardContext } from '@/lib/chat'
import { readModelConfig } from '@/features/rag/hooks/useModelConfig'

/** What the keycard builder has on screen. Read through a ref, so it is never a dependency. */
export interface KeycardChatState {
  spec: KeycardSpec
  keycardId?: string
}

export type KeycardChat = ProposalChat

export function useKeycardChat(state: KeycardChatState): KeycardChat {
  const live = useRef(state)
  live.current = state

  return useProposalChat({
    profile: 'keycard-builder',
    buildContext: (lastApplied): KeycardContext => {
      const spec = live.current.spec as unknown as Record<string, unknown>
      const objective = live.current.spec.nodes
        .filter((n) => n.type === 'context')
        .map((n) => String(n.config.text ?? '').trim())
        .filter(Boolean)
        .join('\n')
      return {
        spec: live.current.spec,
        keycard_id: live.current.keycardId ?? null,
        saved: Boolean(live.current.keycardId),
        assumed: lastApplied?.assumed.filter(
          (a) => JSON.stringify(spec[a.path]) === JSON.stringify(a.value)) ?? null,
        context: objective || undefined,
      }
    },
    sendOptions: () => {
      const cfg = readModelConfig()
      return cfg.model ? { model: cfg.model } : undefined
    },
  })
}

/** Whether the keycard chat backend is usable at all. */
export function useKeycardChatConfigured(): boolean | null {
  return useProfileConfigured('keycard-builder')
}
