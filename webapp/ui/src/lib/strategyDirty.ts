/**
 * Whether the open strategy has edits the store has not seen.
 *
 * Deliberately a comparison against a baseline snapshot rather than a revision
 * counter. `setSpec` fires from six places, and two of them without a user
 * touching anything — the canvas-to-spec sync on mount, and the `test_end`
 * patch that lands when `GET /data-stores` answers. A counter would report a
 * freshly loaded builder as dirty within 300ms, and every "it says unsaved and
 * I did nothing" bug teaches people to ignore the indicator.
 *
 * `changedKeys` does the work because it JSON-compares per key, which is what
 * `features` needs: reference equality reports every spec as wholly changed,
 * and a shallow compare misses an edited expression.
 */
import type { StrategySpec } from '@/lib/api'
import { changedKeys } from '@/lib/specDiff'

/** The spec as it was the last time it agreed with the world. */
export type Baseline = StrategySpec

/**
 * Fields edited since the baseline, in spec key order.
 *
 * Exported so the indicator can answer "what did I change?" in a tooltip
 * without anyone opening a diff view.
 */
/**
 * Server bookkeeping carried by a `StoredStrategy` but absent from the spec
 * the user edits. The baseline is set to the *server's* record after a save,
 * so without this list the id and timestamps alone would read as "edits" and
 * the dot would go dirty the instant a save succeeded — permanently.
 */
const STORED_ONLY_KEYS = [
  'id', 'created_at', 'updated_at', 'user_id', 'visibility',
] as const

export function dirtyFields(spec: StrategySpec, baseline: Baseline): string[] {
  return changedKeys(
    baseline as unknown as Record<string, unknown>,
    spec as unknown as Record<string, unknown>,
    STORED_ONLY_KEYS,
  )
}

export function isDirty(spec: StrategySpec, baseline: Baseline): boolean {
  return dirtyFields(spec, baseline).length > 0
}

/** Dot states. Three, not two: a never-saved draft must not nag before it is worth saving. */
export type SaveState = 'saved' | 'unsaved-edits' | 'never-saved' | 'clean-draft'

export function saveState(dirty: boolean, currentId?: string): SaveState {
  if (currentId) return dirty ? 'unsaved-edits' : 'saved'
  return dirty ? 'never-saved' : 'clean-draft'
}

export const SAVE_STATE_LABELS: Readonly<Record<SaveState, string>> = {
  'saved': 'Saved',
  'unsaved-edits': 'Unsaved edits',
  'never-saved': 'Not saved yet',
  'clean-draft': '',
}
