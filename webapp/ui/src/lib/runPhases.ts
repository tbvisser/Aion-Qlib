/**
 * The stages a backtest passes through, in the order the runner reports them.
 *
 * Mirrors `_PHASE_PATTERNS` in `webapp/api/runner.py`. The server sends a phase
 * *name* and nothing else, so knowing the sequence is the only way to draw how
 * far into a run something is. Duplicating five strings is the cheap half of
 * that trade; the expensive half is a phase the server adds and this list has
 * never heard of, which is why an unrecognised name resolves to `null` and the
 * caller draws an indeterminate track rather than a confident wrong position.
 *
 * `Queued`, `Starting`, `Done`, `Failed` and `Cancelled` are deliberately not
 * here: they bracket the run rather than sit inside it, and the runner itself
 * keeps them out of its ordering table for the same reason.
 */
export const RUN_PHASES = [
  'Loading data',
  'Training model',
  'Generating predictions',
  'Running backtest',
  'Analysing portfolio',
] as const

export type RunPhase = (typeof RUN_PHASES)[number]

/**
 * Where a phase name sits in the sequence, or `null` when it is not one of the
 * five — before the first (queued, starting), after the last (done, failed),
 * or a stage this build does not know about.
 */
export function phaseIndex(phase: string | null | undefined): number | null {
  if (!phase) return null
  const index = (RUN_PHASES as readonly string[]).indexOf(phase)
  return index === -1 ? null : index
}

/**
 * Stages a run has behind it, for a part-of-whole glyph.
 *
 * The current stage is not counted: it is in progress, not finished, and a run
 * that has just entered `Analysing portfolio` showing 5 of 5 would read as
 * over. The ring fills the rest of the way when the run leaves the strip.
 */
export function stagesComplete(phase: string | null | undefined): number {
  return phaseIndex(phase) ?? 0
}
