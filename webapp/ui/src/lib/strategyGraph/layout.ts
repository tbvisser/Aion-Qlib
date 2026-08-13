/**
 * Where the seven stage cards sit: a ring around a hub. Computed, never stored.
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
 * ## Why a ring
 *
 * Seven cards on a row was 1,988px wide. Nothing on any screen this app targets
 * shows that at zoom 1, so the canvas panned and the overview had to be a
 * separate strip of text above it. The same seven cards ringed around a hub is
 * 813x740 -- an aspect ratio of 1.10 against the row's 17.8 -- which does fit
 * the pane at zoom 1, so the picture is its own overview. And the middle of a
 * ring is somewhere a row never had: a place to say what the seven cards add
 * up to.
 *
 * ## Why not a circle
 *
 * The first ring spaced the seven cards evenly on one radius, and the picture
 * read as a geometric figure first and a pipeline second. So the ring is now
 * hand-tuned (`STAGE_POLAR`): every card still circles the hub and the order
 * still runs clockwise from the top, but each card sits at its own bearing and
 * distance. The invariants that made the circle work -- no overlaps, hub
 * clearance, centred on the hub, fits the pane -- survive in layout.test.ts;
 * the even spacing and mirror symmetry were the circle's and went with it.
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
 * 200x148 rather than the row's 236x112.
 *
 * On a ring the binding constraint is the pair either side of the seam, whose
 * centres are 0.7818R apart in x -- so every pixel of card *width* costs 1.28
 * pixels of radius and 2.5 of bounding box, while height is nearly free. Squarer
 * buys the ring for less. 148 is what the card needs: header, headline, up to
 * two detail rows (one of which wraps) and a badge.
 *
 * Uniform rather than per-stage, still: seven cards of different heights on one
 * ring reads as a mistake exactly as it did on a row, and the whole picture has
 * to stay deterministic.
 */
export const STAGE_W = 200
export const STAGE_H = 148

/** Bigger than a card, because it is not one. */
export const HUB_W = 216
export const HUB_H = 156

/**
 * Hand-tuned polar coordinates: a ring, not a circle.
 *
 * -97 (not -90) still lands `01 Store` at the top -- the eye goes to the top of
 * a ring and should land on a card marked `01` -- and the run goes clockwise
 * (y grows down, so a rising angle is clockwise on screen). Radii stay near
 * 300, the smallest that clears every pair with room for an arrowhead, and
 * wander 285..335 so no three cards suggest an arc of one circle.
 *
 * The numbers are hand-placed against the invariants layout.test.ts pins: no
 * two cards overlap on either axis, every card clears the hub, the centroid
 * stays within a whisker of the origin so the hub still reads as the centre,
 * one full clockwise turn with no doubling back, and the whole picture fits an
 * 890x807 pane at zoom 1. Nudge for looks, but keep those green.
 */
export const STAGE_POLAR: Readonly<Record<StageId, { angle: number; radius: number }>> = {
  store:     { angle: -97,  radius: 290 },
  universe:  { angle: -38,  radius: 335 },
  features:  { angle: 14,   radius: 300 },
  periods:   { angle: 67,   radius: 330 },
  learner:   { angle: 121,  radius: 285 },
  portfolio: { angle: 172,  radius: 325 },
  costs:     { angle: -146, radius: 305 },
}

const rad = (deg: number) => (deg * Math.PI) / 180

/** Each card's bearing, in pipeline order. Exported so a test can pin the clockwise run. */
export function stageAngles(
  order: readonly StageId[] = STAGE_ORDER,
): Record<StageId, number> {
  const out = {} as Record<StageId, number>
  for (const id of order) out[id] = STAGE_POLAR[id].angle
  return out
}

/**
 * Card centres. Rounded to whole pixels: React Flow positions nodes with a CSS
 * transform, and a fractional one blurs 11px mono text.
 */
export function stageCentres(
  order: readonly StageId[] = STAGE_ORDER,
): Record<StageId, XY> {
  const angles = stageAngles(order)
  const out = {} as Record<StageId, XY>
  for (const id of order) {
    out[id] = {
      x: Math.round(STAGE_POLAR[id].radius * Math.cos(rad(angles[id]))),
      y: Math.round(STAGE_POLAR[id].radius * Math.sin(rad(angles[id]))),
    }
  }
  return out
}

/** What React Flow wants: the card's top-left. */
export function stagePositions(
  order: readonly StageId[] = STAGE_ORDER,
): Record<StageId, XY> {
  const centres = stageCentres(order)
  const out = {} as Record<StageId, XY>
  for (const id of order) {
    out[id] = { x: centres[id].x - STAGE_W / 2, y: centres[id].y - STAGE_H / 2 }
  }
  return out
}

/** The hub is centred on the origin, which is also the centroid of the ring. */
export function hubPosition(): XY {
  return { x: -HUB_W / 2, y: -HUB_H / 2 }
}

/* -- The features fan ------------------------------------------------------ */

/**
 * A feature chip: a name and an expression, not a stage.
 *
 * 156x40 against a card's 200x148. Smaller on both axes by enough that the two
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
 * Chip centres sit on a circle of this radius around the features card's
 * centre, which is the same "hangs off its parent" relationship the ring has
 * with the hub, one level down.
 */
const FEATURE_FAN_R = 200

/**
 * Vertical pitch between neighbouring chips.
 *
 * The fan is spaced by equal *rise* rather than equal angle, which is the one
 * decision that makes overlap impossible by construction: at a constant 52 >
 * FEATURE_CHIP_H, neighbours are always 12px apart no matter how many there
 * are. An equal-angle fan fails exactly where it is most crowded -- at 16 deg
 * steps the outer pairs come within 31px vertically, and 40px-tall chips
 * collide.
 */
const FEATURE_FAN_PITCH = 52

/**
 * Where the feature chips sit: an arc bulging out to the right of the features
 * card, away from the hub.
 *
 * The features card is at bearing 14 degrees, which is as near to due east as
 * the ring gets, and everything outside it there is empty: the chain enters the
 * card's top from universe and leaves its bottom for periods, both staying left
 * of x = 300, while the chips start at x = 338. The arc is centred on the card's
 * own centreline so the fan stays balanced between universe above and periods
 * below however many chips there are.
 *
 * This is the *collapsed* shape, which is at most seven chips: the arc cannot
 * stretch past that. `dx` goes imaginary once |dy| reaches the radius, at nine,
 * and eight is already wrong on screen -- the outermost chip's left edge lands
 * inside the features card and only misses it on the other axis. Expanding is
 * `featureGridCentres`, a different shape for a different job.
 *
 * Worst case here the picture grows only rightwards, to 991x740, which still
 * fits the pane at the 0.85 zoom floor. `pipelineBoundsWith` is the
 * satellite-aware bounds; `pipelineBounds` deliberately still describes the ring
 * alone.
 */
export function featureFanCentres(count: number, order: readonly StageId[] = STAGE_ORDER): XY[] {
  const n = Math.min(Math.max(count, 0), FEATURE_FAN_MAX)
  if (n === 0) return []
  const at = stageCentres(order).features
  const out: XY[] = []
  for (let i = 0; i < n; i += 1) {
    const dy = (i - (n - 1) / 2) * FEATURE_FAN_PITCH
    const dx = Math.sqrt(FEATURE_FAN_R * FEATURE_FAN_R - dy * dy)
    out.push({ x: Math.round(at.x + dx), y: Math.round(at.y + dy) })
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
 * Eleven is the largest count whose block still sits inside the ring's own
 * vertical band: at eleven the column spans -207..353 against the ring's
 * -362..378, and a twelfth would poke out of the bottom and cost the "grows
 * rightwards only" property that keeps an expanded strategy the same picture
 * with more to the right of it.
 */
export const FEATURE_GRID_ROWS = 11

/**
 * Deliberately the fan's radius, which is what makes expanding read as the arc
 * *straightening* rather than as the chips jumping somewhere else: the first
 * column lands exactly where the arc's middle chip already was, and since the
 * row pitch and the centring rule are shared, every chip's y is unchanged for
 * any count the arc could have drawn. A test pins that.
 */
const FEATURE_GRID_DX = FEATURE_FAN_R

/** Chip width plus a 20px gutter. Wider than the 12px vertical one, which is
 *  what it takes for two gutters at right angles to look the same size. */
const FEATURE_GRID_COL_PITCH = 176

/**
 * Where the feature chips sit once the fan is expanded: a column-wrapping grid
 * in the same empty space to the right of the ring.
 *
 * Columns fill top to bottom and then left to right, and the rows are balanced
 * across the columns rather than packed -- twelve chips is two columns of six,
 * not eleven and a straggler.
 *
 * The clearance argument is stronger here than the arc's, and it holds at every
 * count rather than case by case: the leftmost chip edge is 413 and the
 * rightmost point of any stage card is the features card's own right edge at
 * 391, so the whole grid is right of the entire ring on one axis alone. Chips
 * clear each other by 12px down a column and 20px across.
 *
 * Full at 34 chips the picture is 1519x740 -- four columns -- which no longer
 * fits the pane whole. That is deliberate and handled at the viewport instead:
 * expanding frames the features card and its chips (`featureBlockBounds`), not
 * the ring, and that box fits at zoom 0.91 at every count.
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

/** The shape the chips take in each state. The only thing that knows they are
 *  alternatives; everything downstream just asks for positions. */
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
 *
 * Framing this instead of the whole picture is what keeps an expanded fan
 * readable: the ring plus four columns of chips would have to be shown at zoom
 * 0.54, well under the 0.85 floor where the cards stop being legible, while
 * this box never needs less than 0.91 at any count. A test pins that, which is
 * the same reason `pipelineBoundsWith` exists.
 */
export function featureBlockBounds(
  count: number,
  expanded: boolean,
  order: readonly StageId[] = STAGE_ORDER,
): Box {
  const at = stageCentres(order).features
  let minX = at.x - STAGE_W / 2
  let minY = at.y - STAGE_H / 2
  let maxX = at.x + STAGE_W / 2
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
 * On a row this was always Left then Right. On a ring the predecessor and the
 * successor are at arbitrary bearings, so the side is whichever one the chord to
 * that neighbour actually crosses -- compared in *card widths* rather than
 * pixels, because a 200x148 card exits its short side sooner than a square one
 * would. That comparison is also what feeds the bezier its control direction,
 * which is why the chain curves along the ring with no custom edge component.
 *
 * The first stage has no predecessor and the last no successor; the unused
 * handle goes on the side opposite the used one, so the two can never stack.
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
    // A one-stage pipeline has neither neighbour. Not reachable from
    // STAGE_ORDER, but the function takes an order, so it has an answer.
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
 * Everything drawn, hub included. Replaces `pipelineWidth`: a ring has two
 * interesting dimensions, and its own origin is not its top-left.
 *
 * `{ x: -422, y: -362, width: 813, height: 740 }` for the seven stages.
 */
export function pipelineBounds(order: readonly StageId[] = STAGE_ORDER): Box {
  const hub = hubPosition()
  let minX = hub.x
  let minY = hub.y
  let maxX = hub.x + HUB_W
  let maxY = hub.y + HUB_H
  for (const p of Object.values(stagePositions(order)) as XY[]) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + STAGE_W)
    maxY = Math.max(maxY, p.y + STAGE_H)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * The same box with the features fan included. Equals `pipelineBounds()` when
 * there are no chips, which is every strategy that has not been given custom
 * columns.
 *
 * Separate from `pipelineBounds` rather than folded into it, because the ring's
 * near-square aspect is a property worth keeping assertable on its own: the
 * chips grow the picture rightwards only -- to 1.34 at a full fan and 2.05 at a
 * full grid -- and a single function could no longer say anything about either
 * shape. Nothing at runtime reads this to fit the view -- React Flow measures
 * the nodes it was given -- so it exists for the test that pins the worst case,
 * and for a caller that ever needs the number.
 */
export function pipelineBoundsWith(
  satellites: number,
  expanded = false,
  order: readonly StageId[] = STAGE_ORDER,
): Box {
  const ring = pipelineBounds(order)
  const chips = featureChipPositions(satellites, expanded, order)
  if (chips.length === 0) return ring
  let minX = ring.x
  let minY = ring.y
  let maxX = ring.x + ring.width
  let maxY = ring.y + ring.height
  for (const p of chips) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + FEATURE_CHIP_W)
    maxY = Math.max(maxY, p.y + FEATURE_CHIP_H)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}
