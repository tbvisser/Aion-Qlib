/**
 * Where the seven stage cards sit. Computed, never stored.
 *
 * `factorExpr/layout.ts` stores hand-placed positions because there the shape
 * is user-generated and unbounded, so "hand-placed wins" preserves a real
 * preference. None of that applies here:
 *
 *   - There is nothing to preserve. Seven nodes, fixed order, nothing to move.
 *   - There is nowhere to put them. `StrategySpec` is the wire contract,
 *     mirrored in `webapp/api/strategies.py`, persisted per strategy and
 *     carried by every template; a `positions` map would ship view state into
 *     the qrun config and into every saved row.
 *   - Component-state positions would be worse than none: a saved strategy
 *     reopened would come back arranged differently from how it was left.
 *
 * So: same spec, same picture, in a screenshot, a template, a reload and a test.
 */
import { STAGE_ORDER, type StageId } from './stages'

export type XY = { x: number; y: number }

export const STAGE_W = 236
/**
 * Eyebrow, headline, one or two detail lines, and a badge when there is one.
 *
 * It was 144 while the bold line was the stage's description and the value sat
 * at the bottom, which left a visible gap in the middle of every card. Leading
 * with the value removed the thing the height was there to separate.
 *
 * Uniform rather than per-stage: seven cards of different heights on one row
 * reads as a mistake, and the whole picture has to stay deterministic.
 */
export const STAGE_H = 112
/** Enough for the edge to read as a connection rather than a seam. */
export const STAGE_GAP = 56

/** Left-to-right on one row. Exported so a test can pin the pitch. */
export function stagePositions(
  order: readonly StageId[] = STAGE_ORDER,
): Record<StageId, XY> {
  const out = {} as Record<StageId, XY>
  order.forEach((id, i) => {
    out[id] = { x: i * (STAGE_W + STAGE_GAP), y: 0 }
  })
  return out
}

/** Total width of the laid-out chain, for the initial viewport and the strip. */
export function pipelineWidth(order: readonly StageId[] = STAGE_ORDER): number {
  return order.length === 0 ? 0 : order.length * STAGE_W + (order.length - 1) * STAGE_GAP
}
