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
 * The shared machinery — applied/dismissed sets, the last-applied ref behind
 * the `assumed` filter — lives in `useProposalChat`, which `useKeycardChat`
 * builds on too. Only the context sent each turn is this hook's own.
 */
import { useRef } from 'react'

import { useProposalChat, useProfileConfigured, type ProposalChat }
  from '@/hooks/useProposalChat'
import type { FeatureMode, StrategySpec } from '@/lib/api'
import type { BuilderContext } from '@/lib/chat'
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

export type BuilderChat = ProposalChat

export function useBuilderChat(state: BuilderChatState): BuilderChat {
  // Read through a ref so the context builder always sees the current screen
  // without being a dependency of anything.
  const live = useRef(state)
  live.current = state

  return useProposalChat({
    profile: 'builder',
    buildContext: (lastApplied): BuilderContext => {
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
        assumed: lastApplied?.assumed.filter(
          (a) => JSON.stringify(spec[a.path]) === JSON.stringify(a.value)) ?? null,
        context: live.current.spec.context,
      }
    },
  })
}

/** Whether the builder chat backend is usable at all. */
export function useChatConfigured(): boolean | null {
  return useProfileConfigured('builder')
}
