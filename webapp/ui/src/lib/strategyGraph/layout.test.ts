import { describe, expect, it } from 'vitest'

import {
  FEATURE_CHIP_H, FEATURE_CHIP_W, FEATURE_FAN_MAX, FEATURE_GRID_MAX, FEATURE_GRID_ROWS,
  HUB_H, HUB_W, STAGE_H, STAGE_W,
  featureBlockBounds, featureFanCentres, featureFanPositions, featureGridCentres,
  featureChipPositions, hubPosition, pipelineBounds, pipelineBoundsWith,
  stageAngles, stageCentres, stagePositions, stageSides,
} from './layout'
import { STAGE_ORDER } from './stages'

const N = STAGE_ORDER.length

describe('stagePositions', () => {
  it('is deterministic — the same spec always draws the same picture', () => {
    expect(stagePositions()).toEqual(stagePositions())
  })

  it('places one card per stage', () => {
    expect(Object.keys(stagePositions()).sort()).toEqual([...STAGE_ORDER].sort())
  })

  it('keeps every card in a ring band around the hub, but not on one circle', () => {
    const at = stageCentres()
    const radii = STAGE_ORDER.map((id) => Math.hypot(at[id].x, at[id].y))
    for (const r of radii) {
      // Near enough one distance to read as a ring around the hub…
      expect(r).toBeGreaterThan(260)
      expect(r).toBeLessThan(360)
    }
    // …and spread enough that the picture cannot collapse back into the
    // geometric circle the organic ring exists to not be.
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(20)
  })

  it('runs clockwise from the top, one full turn, without doubling back', () => {
    const angles = stageAngles()
    // y grows downward, so -90 is twelve o'clock and a rising angle is
    // clockwise. The exact bearing is hand-tuned; "01 lands at the top" is the
    // part a reader relies on.
    expect(angles[STAGE_ORDER[0]]).toBeGreaterThan(-110)
    expect(angles[STAGE_ORDER[0]]).toBeLessThan(-70)
    // Uneven steps are the point, but each must stay a step: forward (no card
    // doubles back over its predecessor), and no gap so wide the ring tears.
    // Wrapping the last step back to the first card makes the seven sum to
    // exactly one revolution.
    let total = 0
    for (let i = 0; i < N; i += 1) {
      const a = angles[STAGE_ORDER[i]]
      const b = angles[STAGE_ORDER[(i + 1) % N]]
      const step = (((b - a) % 360) + 360) % 360
      expect(step).toBeGreaterThan(20)
      expect(step).toBeLessThan(90)
      total += step
    }
    expect(total).toBe(360)
  })

  it('keeps the hub the centre of gravity of the cards', () => {
    // Within a whisker rather than exact: hand-tuned bearings trade the evenly
    // spaced ring's zero-sum for a livelier picture, but if the centroid
    // drifts a card-width the hub stops reading as the middle.
    const at = stageCentres()
    const sum = STAGE_ORDER.reduce(
      (acc, id) => ({ x: acc.x + at[id].x, y: acc.y + at[id].y }),
      { x: 0, y: 0 },
    )
    expect(Math.abs(sum.x / N)).toBeLessThan(40)
    expect(Math.abs(sum.y / N)).toBeLessThan(40)
    expect(hubPosition()).toEqual({ x: -HUB_W / 2, y: -HUB_H / 2 })
  })

  /**
   * The row's "exact pitch" test, restated for a ring.
   *
   * One number settled it on a row. On a ring it does not: `store` and `costs`
   * are 218px apart in x and only 117px apart in y, so they clear each other on
   * x while *overlapping* on y -- which a chord-length or single-axis check would
   * pass and a reader would see as two cards on top of each other. Axis-aligned
   * boxes miss iff they are clear on at least one axis, so every pair is checked
   * on both.
   */
  it('leaves no two cards overlapping, at any angle', () => {
    const at = stageCentres()
    for (let i = 0; i < N; i += 1) {
      for (let j = i + 1; j < N; j += 1) {
        const dx = Math.abs(at[STAGE_ORDER[i]].x - at[STAGE_ORDER[j]].x)
        const dy = Math.abs(at[STAGE_ORDER[i]].y - at[STAGE_ORDER[j]].y)
        expect(Math.max(dx - STAGE_W, dy - STAGE_H)).toBeGreaterThan(0)
      }
    }
  })

  it('leaves the hub clear of every card, so every spoke is visible', () => {
    const at = stageCentres()
    for (const id of STAGE_ORDER) {
      const dx = Math.abs(at[id].x) - (STAGE_W + HUB_W) / 2
      const dy = Math.abs(at[id].y) - (STAGE_H + HUB_H) / 2
      expect(Math.max(dx, dy)).toBeGreaterThan(0)
    }
  })
})

describe('stageSides', () => {
  it('never stacks a card\'s two chain handles on one side', () => {
    for (const sides of Object.values(stageSides())) {
      expect(sides.in).not.toBe(sides.out)
    }
  })

  /**
   * Hand-checked against the picture, because the rule that computes these is
   * the thing under test and re-deriving it here would assert nothing.
   */
  it('leaves each card on the side its successor is actually on', () => {
    const sides = stageSides()
    // `store` is at the top and `universe` off to its lower right; the chord is
    // far wider than it is tall, so the chain leaves right.
    expect(sides.store.out).toBe('right')
    // `periods` and `learner` both sit along the bottom of the ring, so
    // 04 -> 05 runs leftwards across the bottom.
    expect(sides.periods.out).toBe('left')
    expect(sides.learner.in).toBe('right')
  })

  it('parks the unused end handle opposite the used one', () => {
    const sides = stageSides()
    expect(sides[STAGE_ORDER[0]].in).toBe('left')       // no predecessor
    expect(sides[STAGE_ORDER[N - 1]].out).toBe('top')   // no successor
  })
})

describe('pipelineBounds', () => {
  it('encloses the hub and every card', () => {
    const b = pipelineBounds()
    const at = stagePositions()
    expect(b.x).toBeLessThanOrEqual(-HUB_W / 2)
    expect(b.y).toBeLessThanOrEqual(-HUB_H / 2)
    for (const id of STAGE_ORDER) {
      expect(at[id].x).toBeGreaterThanOrEqual(b.x)
      expect(at[id].y).toBeGreaterThanOrEqual(b.y)
      expect(at[id].x + STAGE_W).toBeLessThanOrEqual(b.x + b.width)
      expect(at[id].y + STAGE_H).toBeLessThanOrEqual(b.y + b.height)
    }
  })

  /**
   * The reason the ring exists, as an assertion.
   *
   * 890x807 is the pipeline pane in a 1440x900 window with the sidebar expanded
   * and the stage inspector closed: 1440 - 261 (sidebar) - 289 (builder rail), by
   * 900 - 93 (page header). Seven cards on a row was 1,988px and could never be
   * shown whole; if this ever stops fitting, the canvas has quietly gone back to
   * being something you have to pan.
   */
  it('fits a 1440px window at zoom 1', () => {
    const b = pipelineBounds()
    expect(b.width).toBeLessThanOrEqual(890)
    expect(b.height).toBeLessThanOrEqual(807)
    expect(b.width / b.height).toBeGreaterThan(0.8)
    expect(b.width / b.height).toBeLessThan(1.25)
  })

  it('is just the hub when there are no stages', () => {
    expect(pipelineBounds([])).toEqual({
      x: -HUB_W / 2, y: -HUB_H / 2, width: HUB_W, height: HUB_H,
    })
  })
})

describe('featureFanPositions', () => {
  it('is deterministic — the same feature set always draws the same fan', () => {
    expect(featureFanPositions(FEATURE_FAN_MAX)).toEqual(featureFanPositions(FEATURE_FAN_MAX))
  })

  it('draws nothing for a strategy with no custom columns', () => {
    expect(featureFanPositions(0)).toEqual([])
  })

  it('never draws more chips than the fan holds', () => {
    // `toFlow` caps the roster at FEATURE_FAN_MAX; the clamp here is what keeps
    // a caller that forgets from silently stacking chips on top of each other.
    expect(featureFanPositions(FEATURE_FAN_MAX)).toHaveLength(FEATURE_FAN_MAX)
    expect(featureFanPositions(99)).toHaveLength(FEATURE_FAN_MAX)
  })

  it('reads top to bottom, at the pitch that makes overlap impossible', () => {
    const at = featureFanCentres(FEATURE_FAN_MAX)
    for (let i = 1; i < at.length; i += 1) {
      // A constant rise, not a constant angle: this is the invariant, and it is
      // larger than the chip is tall, so neighbours cannot touch at any count.
      expect(at[i].y - at[i - 1].y).toBe(52)
    }
    expect(52).toBeGreaterThan(FEATURE_CHIP_H)
  })

  it('leaves no two chips overlapping, at any count', () => {
    for (let n = 1; n <= FEATURE_FAN_MAX; n += 1) {
      const at = featureFanCentres(n)
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const dx = Math.abs(at[i].x - at[j].x)
          const dy = Math.abs(at[i].y - at[j].y)
          expect(Math.max(dx - FEATURE_CHIP_W, dy - FEATURE_CHIP_H)).toBeGreaterThan(0)
        }
      }
    }
  })

  /**
   * The fan is the one thing on this canvas that grows, so it is the one thing
   * that can grow into something else. Checked against every card and the hub
   * rather than just the three it passes near, because the ring is hand-tuned
   * and a nudge there moves what the fan has to clear.
   */
  it('clears every card and the hub, at full size', () => {
    const chips = featureFanCentres(FEATURE_FAN_MAX)
    const cards = stageCentres()
    for (const chip of chips) {
      for (const id of STAGE_ORDER) {
        const dx = Math.abs(chip.x - cards[id].x) - (STAGE_W + FEATURE_CHIP_W) / 2
        const dy = Math.abs(chip.y - cards[id].y) - (STAGE_H + FEATURE_CHIP_H) / 2
        expect(Math.max(dx, dy)).toBeGreaterThan(0)
      }
      const hubDx = Math.abs(chip.x) - (HUB_W + FEATURE_CHIP_W) / 2
      const hubDy = Math.abs(chip.y) - (HUB_H + FEATURE_CHIP_H) / 2
      expect(Math.max(hubDx, hubDy)).toBeGreaterThan(0)
    }
  })

  it('hangs off the features card: outside it, and never far from it', () => {
    const features = stageCentres().features
    for (const chip of featureFanCentres(FEATURE_FAN_MAX)) {
      // Outward, into the empty space the chain never crosses…
      expect(chip.x).toBeGreaterThan(features.x)
      // …but close enough that the tether reads as belonging, not as a journey.
      expect(Math.hypot(chip.x - features.x, chip.y - features.y)).toBeLessThan(260)
    }
  })
})

describe('pipelineBoundsWith', () => {
  it('is the ring itself when a strategy has no custom columns', () => {
    expect(pipelineBoundsWith(0)).toEqual(pipelineBounds())
  })

  /**
   * The fan may not cost the canvas its fit. 1045x947 is the 890x807 pane at the
   * 0.85 zoom floor (`FIT.minZoom` in PipelineCanvas) -- past that the picture
   * has to be panned, which is the thing the ring exists to avoid.
   */
  it('still fits the pane at the zoom floor, at full size', () => {
    const b = pipelineBoundsWith(FEATURE_FAN_MAX)
    expect(b.width).toBeLessThanOrEqual(1045)
    expect(b.height).toBeLessThanOrEqual(947)
  })

  it('grows the picture rightwards only', () => {
    const ring = pipelineBounds()
    const withFan = pipelineBoundsWith(FEATURE_FAN_MAX)
    // The fan sits inside the ring's vertical extent, so a strategy with
    // columns is the same picture with more to the right of it -- not a
    // differently shaped one.
    expect(withFan.y).toBe(ring.y)
    expect(withFan.height).toBe(ring.height)
    expect(withFan.x).toBe(ring.x)
    expect(withFan.width).toBeGreaterThan(ring.width)
  })
})

describe('featureGridCentres', () => {
  it('is deterministic — the same feature set always draws the same grid', () => {
    expect(featureGridCentres(FEATURE_GRID_MAX)).toEqual(featureGridCentres(FEATURE_GRID_MAX))
  })

  it('draws nothing for a strategy with no custom columns', () => {
    expect(featureGridCentres(0)).toEqual([])
  })

  it('never draws more chips than the grid holds', () => {
    // There is no client-side cap on `spec.features` -- the 32 is the server's
    // -- so a draft can ask for more chips than exist positions for. The clamp
    // is what stops a node being minted without one.
    expect(featureGridCentres(FEATURE_GRID_MAX)).toHaveLength(FEATURE_GRID_MAX)
    expect(featureGridCentres(99)).toHaveLength(FEATURE_GRID_MAX)
  })

  it('stacks no more than one column\'s worth before wrapping', () => {
    for (let n = 1; n <= FEATURE_GRID_MAX; n += 1) {
      const byColumn = new Map<number, number>()
      for (const c of featureGridCentres(n)) {
        byColumn.set(c.x, (byColumn.get(c.x) ?? 0) + 1)
      }
      for (const held of byColumn.values()) {
        expect(held).toBeLessThanOrEqual(FEATURE_GRID_ROWS)
      }
    }
  })

  it('balances the columns rather than packing them', () => {
    // Twelve chips is two columns of six, not eleven and a straggler.
    const shape = (n: number): number[] => {
      const byColumn = new Map<number, number>()
      for (const c of featureGridCentres(n)) {
        byColumn.set(c.x, (byColumn.get(c.x) ?? 0) + 1)
      }
      return [...byColumn.entries()].sort((a, b) => a[0] - b[0]).map(([, held]) => held)
    }
    expect(shape(12)).toEqual([6, 6])
    expect(shape(22)).toEqual([11, 11])
    expect(shape(23)).toEqual([8, 8, 7])
    expect(shape(FEATURE_GRID_MAX)).toEqual([9, 9, 9, 7])
  })

  it('pitches the chips exactly, down a column and across', () => {
    const at = featureGridCentres(FEATURE_GRID_MAX)
    // Same 52 as the fan, which is what makes expanding a straightening.
    expect(at[1].y - at[0].y).toBe(52)
    // Wider across than down: two gutters at right angles only look equal when
    // the horizontal one is bigger.
    const columns = [...new Set(at.map((c) => c.x))].sort((a, b) => a - b)
    expect(columns[1] - columns[0]).toBe(176)
  })

  it('leaves no two chips overlapping, at any count', () => {
    for (let n = 1; n <= FEATURE_GRID_MAX; n += 1) {
      const at = featureGridCentres(n)
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          const dx = Math.abs(at[i].x - at[j].x)
          const dy = Math.abs(at[i].y - at[j].y)
          expect(Math.max(dx - FEATURE_CHIP_W, dy - FEATURE_CHIP_H)).toBeGreaterThan(0)
        }
      }
    }
  })

  /**
   * A stronger claim than the fan's, and it holds at every count rather than
   * case by case: the entire grid is right of the entire ring, so one axis
   * settles every pair without ever consulting y.
   */
  it('clears the whole ring on one axis, at any count', () => {
    const cards = stageCentres()
    const ringRight = Math.max(
      ...STAGE_ORDER.map((id) => cards[id].x + STAGE_W / 2),
      HUB_W / 2,
    )
    for (let n = 1; n <= FEATURE_GRID_MAX; n += 1) {
      const leftmost = Math.min(...featureGridCentres(n).map((c) => c.x)) - FEATURE_CHIP_W / 2
      expect(leftmost).toBeGreaterThan(ringRight)
    }
  })

  it('stays inside the ring\'s vertical band, at any count', () => {
    const ring = pipelineBounds()
    for (let n = 1; n <= FEATURE_GRID_MAX; n += 1) {
      const at = featureGridCentres(n)
      expect(Math.min(...at.map((c) => c.y)) - FEATURE_CHIP_H / 2)
        .toBeGreaterThanOrEqual(ring.y)
      expect(Math.max(...at.map((c) => c.y)) + FEATURE_CHIP_H / 2)
        .toBeLessThanOrEqual(ring.y + ring.height)
    }
  })

  it('centres every column on the features card', () => {
    const features = stageCentres().features
    for (const n of [1, 5, 11, 12, 23, FEATURE_GRID_MAX]) {
      const byColumn = new Map<number, number[]>()
      for (const c of featureGridCentres(n)) {
        byColumn.set(c.x, [...(byColumn.get(c.x) ?? []), c.y])
      }
      for (const ys of byColumn.values()) {
        // Only a full column is centred; a short last one hangs from the top.
        if (ys.length < (byColumn.get([...byColumn.keys()][0])?.length ?? 0)) continue
        const mean = ys.reduce((a, b) => a + b, 0) / ys.length
        expect(Math.abs(mean - features.y)).toBeLessThanOrEqual(0.5)
      }
    }
  })

  /**
   * The claim the shared radius was chosen to earn. If a future retune of the
   * ring breaks it, expanding has stopped being an expansion and become a jump
   * to somewhere else.
   */
  it('is the fan, straightened', () => {
    for (let n = 1; n <= FEATURE_FAN_MAX; n += 1) {
      const fan = featureFanCentres(n)
      const grid = featureGridCentres(n)
      expect(grid.map((c) => c.y)).toEqual(fan.map((c) => c.y))
      grid.forEach((c, i) => expect(c.x).toBeGreaterThanOrEqual(fan[i].x))
    }
  })
})

describe('pipelineBoundsWith, expanded', () => {
  it('is the ring itself when a strategy has no custom columns', () => {
    expect(pipelineBoundsWith(0, true)).toEqual(pipelineBounds())
  })

  it('is four columns wide when the grid is full', () => {
    expect(pipelineBoundsWith(FEATURE_GRID_MAX, true))
      .toEqual({ x: -422, y: -362, width: 1519, height: 740 })
  })

  it('still grows the picture rightwards only, at any count', () => {
    const ring = pipelineBounds()
    for (let n = 1; n <= FEATURE_GRID_MAX; n += 1) {
      const b = pipelineBoundsWith(n, true)
      expect(b.y).toBe(ring.y)
      expect(b.height).toBe(ring.height)
      expect(b.x).toBe(ring.x)
      expect(b.width).toBeGreaterThanOrEqual(ring.width)
    }
  })
})

describe('featureBlockBounds', () => {
  it('always frames the features card, never the chips alone', () => {
    const at = stageCentres().features
    for (const expanded of [false, true]) {
      for (const n of [0, 1, FEATURE_FAN_MAX]) {
        const b = featureBlockBounds(n, expanded)
        expect(b.x).toBeLessThanOrEqual(at.x - STAGE_W / 2)
        expect(b.y).toBeLessThanOrEqual(at.y - STAGE_H / 2)
        expect(b.x + b.width).toBeGreaterThanOrEqual(at.x + STAGE_W / 2)
        expect(b.y + b.height).toBeGreaterThanOrEqual(at.y + STAGE_H / 2)
      }
    }
  })

  /**
   * The reason expanding frames this box instead of the whole picture.
   *
   * The ring plus a full grid is 1519x740, which needs zoom 0.54 -- far under
   * the 0.85 floor where an 11px eyebrow stops being readable. This box never
   * needs less than 0.91 at any count, so the floor is never reached and `FIT`
   * needs no special case.
   */
  it('fits the pane above the zoom floor, at every count', () => {
    // React Flow resolves `padding: 0.08` the way @xyflow/system's parsePadding
    // does: floor((v - v/1.08) * 0.5) per side.
    const pad = (v: number) => 2 * Math.floor((v - v / 1.08) * 0.5)
    for (let n = 1; n <= FEATURE_GRID_MAX; n += 1) {
      const b = featureBlockBounds(n, true)
      const zoom = Math.min((890 - pad(890)) / b.width, (807 - pad(807)) / b.height)
      expect(zoom).toBeGreaterThanOrEqual(0.85)
    }
  })

  it('takes its chips from whichever shape is showing', () => {
    // The arc and the column are genuinely different placements…
    expect(featureChipPositions(3, false)).not.toEqual(featureChipPositions(3, true))
    // …but they occupy the same box while the grid is still one column, because
    // the fan's widest chip is its middle one and that sits exactly on the
    // column. So expanding a fan that never wrapped does not move the viewport.
    expect(featureBlockBounds(FEATURE_FAN_MAX, false))
      .toEqual(featureBlockBounds(FEATURE_FAN_MAX, true))
    // It is wrapping that widens the frame.
    expect(featureBlockBounds(12, true).width)
      .toBeGreaterThan(featureBlockBounds(FEATURE_FAN_MAX, true).width)
  })
})
