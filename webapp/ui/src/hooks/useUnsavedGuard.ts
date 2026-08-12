/**
 * Do this — unless it would throw away unsaved work, in which case ask first.
 *
 * The guard wraps the two *funnels* that replace the spec (`applySpec` and
 * `openSaved`), not the menu that calls them. Everything that can replace a
 * strategy goes through one of those two — the template rail, the factor
 * canvas's copy of it, the front door, the assistant's Apply, and the header
 * switcher — so guarding there covers all of them with no call-site changes.
 * Guarding inside the switcher would have left the other four as unguarded back
 * doors into the same destruction.
 */
import { useCallback, useState } from 'react'

export interface PendingAction {
  /** Completes "Discard changes and …?", e.g. `open “Momentum v3”`. */
  label: string
  run: () => void
}

export interface UnsavedGuard {
  /** Runs immediately when clean; stashes the action and asks when dirty. */
  guard: (action: PendingAction) => void
  pending: PendingAction | null
  /** Run the stashed action, losing the edits. */
  discard: () => void
  cancel: () => void
  /** Run the stashed action after a successful save. */
  resume: () => void
}

export function useUnsavedGuard(dirty: boolean): UnsavedGuard {
  const [pending, setPending] = useState<PendingAction | null>(null)

  const guard = useCallback((action: PendingAction) => {
    if (!dirty) { action.run(); return }
    setPending(action)
  }, [dirty])

  const discard = useCallback(() => {
    setPending((p) => { p?.run(); return null })
  }, [])

  const cancel = useCallback(() => setPending(null), [])

  return { guard, pending, discard, cancel, resume: discard }
}
