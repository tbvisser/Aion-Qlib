/**
 * Where the seven stage cards sit: a narrow vertical stack with the hub above it.
 * Computed, never stored.
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
 *
 * ## Why a vertical stack
 *
 * Seven cards on a row was 1,988px wide. The ring that followed was compact but
 * read as a geometric figure first and a pipeline second. A vertical stack keeps
 * the reading order explicit (top to bottom), makes each card narrower so the
 * whole column fits in a slim pane, and still leaves room for the hub above the
 * pipeline and for feature chips to branch off to the right.
 */
import { STAGE_ORDER, type StageId } from './stages'

export type XY = { x: number; y: number }
export type Box = { x: number; y: number; width: number; height: number }

/**
 * Which edge of a card a handle sits on.
 *
 * Strings rather than `@xyflow/react`'s `Position`: this module stays
 * library-free, which `toFlow.ts` is the sole exception to, and it keeps the
 * sides assertable in a repo with no component tests. `StageNodeCard` maps
 * these onto the library's enum.
 */
export type Side = 'top' | 'right' | 'bottom' | 'left'
export interface StageSides { in: Side; out: Side }

/**
 * 72px tall rather than the ring's 148px. Width varies by stage so the stack is
 * not a perfectly straight column, while staying narrow enough to fit in the
 * pipeline pane without panning.
 */
export const STAGE_H = 72

/** Per-stage widths: wider when the typical headline is longer. */
export const STAGE_WIDTHS: Readonly<Record<StageId, number>> = {
  store: 160,
  universe: 180,
  features: 168,
  periods: 180,
  learner: 160,
  portfolio: 168,
  costs: 180,
}

/** The largest stage width, used for clearance checks and the hub. */
export const STAGE_W = 180

/** Vertical gap between consecutive stage cards. */
export const STAGE_GAP = 16

/** The hub sits above the stack and is sized to match the widest card. */
export const HUB_W = STAGE_W
export const HUB_H = 80

/** Space between the bottom of the hub and the top of the stage stack. */
export const HUB_GAP = 24

/** Top of the stage stack, centred vertically around the origin. */
function stackTop(order: readonly StageId[] = STAGE_ORDER): number {
  return -(order.length * STAGE_H + (order.length - 1) * STAGE_GAP) / 2
}

const stagePitch = STAGE_H + STAGE_GAP

/**
 * Card centres. Rounded to whole pixels: React Flow positions nodes with a CSS
 * transform, and a fractional one blurs 11px mono text.
 */
export function stageCentres(
  order: readonly StageId[] = STAGE_ORDER,
): Record<StageId, XY> {
  const top = stackTop(order)
  const out = {} as Record<StageId, XY>
  for (let i = 0; i < order.length; i += 1) {
    const id = order[i]
    out[id] = {
      x: 0,
      y: Math.round(top + i * stagePitch + STAGE_H / 2),
    }
  }
  return out
}

/** What React Flow wants: the card's top-left. */
export function stagePositions(
  order: readonly StageId[] = STAGE_ORDER,
): Record<StageId, XY> {
  const top = stackTop(order)
  const out = {} as Record<StageId, XY>
  for (let i = 0; i < order.length; i += 1) {
    const id = order[i]
    out[id] = { x: -STAGE_WIDTHS[id] / 2, y: top + i * stagePitch }
  }
  return out
}

/** The hub is centred horizontally above the stage stack. */
export function hubPosition(): XY {
  return { x: -HUB_W / 2, y: stackTop() - HUB_H - HUB_GAP }
}

/* -- The features branch --------------------------------------------------- */

/**
 * A feature chip: a name and an expression, not a stage.
 *
 * 156x40 against a card's 180x72. Smaller on both axes by enough that the two
 * families can never be confused at a glance, and wide enough for a 20-odd
 * character column name at 11px mono.
 */
export const FEATURE_CHIP_W = 156
export const FEATURE_CHIP_H = 40

/** Collapsed: the base chip, five columns and the overflow chip. See `toFlow.ts`. */
export const FEATURE_FAN_MAX = 7

/** Expanded: the base chip, every column the server will take, and the toggle. */
export const FEATURE_GRID_MAX = 34

/**
 * Horizontal offset from the features card's centre to the chip column.
 *
 * The chips sit to the right of the stage column. The right edge of the widest
 * stage card is at STAGE_W/2 = 90; the left edge of a chip is at DX -
 * FEATURE_CHIP_W/2 = 114, leaving a 24px gap so the branch never touches the
 * stack.
 */
const FEATURE_FAN_DX = 192

/**
 * Vertical pitch between neighbouring chips.
 *
 * 52 > FEATURE_CHIP_H, so neighbours never touch.
 */
const FEATURE_FAN_PITCH = 52

/**
 * Where the feature chips sit while collapsed: a single vertical column to the
 * right of the features card, centred on it vertically.
 */
export function featureFanCentres(count: number, order: readonly StageId[] = STAGE_ORDER): XY[] {
  const n = Math.min(Math.max(count, 0), FEATURE_FAN_MAX)
  if (n === 0) return []
  const at = stageCentres(order).features
  const out: XY[] = []
  for (let i = 0; i < n; i += 1) {
    const dy = (i - (n - 1) / 2) * FEATURE_FAN_PITCH
    out.push({ x: Math.round(at.x + FEATURE_FAN_DX), y: Math.round(at.y + dy) })
  }
  return out
}

/** What React Flow wants: each chip's top-left. */
export function featureFanPositions(
  count: number,
  order: readonly StageId[] = STAGE_ORDER,
): XY[] {
  return featureFanCentres(count, order).map((c) => ({
    x: c.x - FEATURE_CHIP_W / 2,
    y: c.y - FEATURE_CHIP_H / 2,
  }))
}

/**
 * The most chips a column holds before the grid wraps.
 *
 * Eleven is the largest count whose block still sits within a comfortable
 * vertical band next to the stage stack.
 */
export const FEATURE_GRID_ROWS = 11

/**
 * The expanded grid starts at the same horizontal offset as the collapsed
 * column, so expanding a short list does not move chips -- it just adds more
 * columns to the right.
 */
const FEATURE_GRID_DX = FEATURE_FAN_DX

/** Chip width plus a 20px gutter. */
const FEATURE_GRID_COL_PITCH = 176

/**
 * Where the feature chips sit once the fan is expanded: a column-wrapping grid
 * in the empty space to the right of the stack.
 *
 * Columns fill top to bottom and then left to right, and the rows are balanced
 * across the columns rather than packed.
 */
export function featureGridCentres(
  count: number,
  order: readonly StageId[] = STAGE_ORDER,
): XY[] {
  const n = Math.min(Math.max(count, 0), FEATURE_GRID_MAX)
  if (n === 0) return []
  const at = stageCentres(order).features
  const cols = Math.ceil(n / FEATURE_GRID_ROWS)
  const rows = Math.ceil(n / cols)
  const out: XY[] = []
  for (let i = 0; i < n; i += 1) {
    const col = Math.floor(i / rows)
    const row = i % rows
    out.push({
      x: at.x + FEATURE_GRID_DX + col * FEATURE_GRID_COL_PITCH,
      y: Math.round(at.y + (row - (rows - 1) / 2) * FEATURE_FAN_PITCH),
    })
  }
  return out
}

/** The shape the chips take in each state. */
export function featureChipCentres(
  count: number,
  expanded: boolean,
  order: readonly StageId[] = STAGE_ORDER,
): XY[] {
  return expanded ? featureGridCentres(count, order) : featureFanCentres(count, order)
}

export function featureChipPositions(
  count: number,
  expanded: boolean,
  order: readonly StageId[] = STAGE_ORDER,
): XY[] {
  return featureChipCentres(count, expanded, order).map((c) => ({
    x: c.x - FEATURE_CHIP_W / 2,
    y: c.y - FEATURE_CHIP_H / 2,
  }))
}

/**
 * The features card and its chips, which is what expanding asks you to look at.
 */
export function featureBlockBounds(
  count: number,
  expanded: boolean,
  order: readonly StageId[] = STAGE_ORDER,
): Box {
  const at = stageCentres(order).features
  const featuresW = STAGE_WIDTHS.features
  let minX = at.x - featuresW / 2
  let minY = at.y - STAGE_H / 2
  let maxX = at.x + featuresW / 2
  let maxY = at.y + STAGE_H / 2
  for (const c of featureChipCentres(count, expanded, order)) {
    minX = Math.min(minX, c.x - FEATURE_CHIP_W / 2)
    minY = Math.min(minY, c.y - FEATURE_CHIP_H / 2)
    maxX = Math.max(maxX, c.x + FEATURE_CHIP_W / 2)
    maxY = Math.max(maxY, c.y + FEATURE_CHIP_H / 2)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

const OPPOSITE: Record<Side, Side> = {
  top: 'bottom', bottom: 'top', left: 'right', right: 'left',
}

function sideTowards(dx: number, dy: number): Side {
  return Math.abs(dx) / STAGE_W >= Math.abs(dy) / STAGE_H
    ? (dx > 0 ? 'right' : 'left')
    : (dy > 0 ? 'bottom' : 'top')
}

/**
 * Which side of a card the chain leaves and enters by.
 *
 * On a vertical stack the predecessor is above and the successor below, so the
 * chain enters through the top and leaves through the bottom. The first stage
 * has no predecessor and the last no successor; the unused handle goes on the
 * side opposite the used one so the two can never stack.
 */
export function stageSides(
  order: readonly StageId[] = STAGE_ORDER,
): Record<StageId, StageSides> {
  const at = stageCentres(order)
  const out = {} as Record<StageId, StageSides>
  order.forEach((id, i) => {
    const prev = i > 0 ? at[order[i - 1]] : null
    const next = i < order.length - 1 ? at[order[i + 1]] : null
    const inSide = prev ? sideTowards(prev.x - at[id].x, prev.y - at[id].y) : null
    const outSide = next ? sideTowards(next.x - at[id].x, next.y - at[id].y) : null
    if (!inSide && !outSide) {
      out[id] = { in: 'left', out: 'right' }
      return
    }
    out[id] = {
      in: inSide ?? OPPOSITE[outSide as Side],
      out: outSide ?? OPPOSITE[inSide as Side],
    }
  })
  return out
}

/**
 * Everything drawn, hub included.
 */
export function pipelineBounds(order: readonly StageId[] = STAGE_ORDER): Box {
  const hub = hubPosition()
  let minX = hub.x
  let minY = hub.y
  let maxX = hub.x + HUB_W
  let maxY = hub.y + HUB_H
  const positions = stagePositions(order)
  for (const id of order) {
    const p = positions[id]
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + STAGE_WIDTHS[id])
    maxY = Math.max(maxY, p.y + STAGE_H)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * The same box with the features branch included. Equals `pipelineBounds()` when
 * there are no chips.
 */
export function pipelineBoundsWith(
  satellites: number,
  expanded = false,
  order: readonly StageId[] = STAGE_ORDER,
): Box {
  const stack = pipelineBounds(order)
  const chips = featureChipPositions(satellites, expanded, order)
  if (chips.length === 0) return stack
  let minX = stack.x
  let minY = stack.y
  let maxX = stack.x + stack.width
  let maxY = stack.y + stack.height
  for (const p of chips) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + FEATURE_CHIP_W)
    maxY = Math.max(maxY, p.y + FEATURE_CHIP_H)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
