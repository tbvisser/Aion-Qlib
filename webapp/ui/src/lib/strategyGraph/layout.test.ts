import { describe, expect, it } from 'vitest'

import {
  FEATURE_CHIP_H, FEATURE_CHIP_W, FEATURE_FAN_MAX, FEATURE_GRID_MAX, FEATURE_GRID_ROWS,
  HUB_GAP, HUB_H, HUB_W, STAGE_GAP, STAGE_H, STAGE_W, STAGE_WIDTHS,
  featureBlockBounds, featureFanCentres, featureFanPositions, featureGridCentres,
  featureChipPositions, hubPosition, pipelineBounds, pipelineBoundsWith,
  stageCentres, stagePositions, stageSides,
} from './layout'
import { STAGE_ORDER } from './stages'

const N = STAGE_ORDER.length
const STAGE_PITCH = STAGE_H + STAGE_GAP

describe('stagePositions', () => {
  it('is deterministic — the same spec always draws the same picture', () => {
    expect(stagePositions()).toEqual(stagePositions())
  })

  it('places one card per stage', () => {
    expect(Object.keys(stagePositions()).sort()).toEqual([...STAGE_ORDER].sort())
  })

  it('lays the cards out as a vertical stack, in pipeline order', () => {
    const at = stagePositions()
    let prevY = at[STAGE_ORDER[0]].y
    for (let i = 0; i < N; i += 1) {
      const id = STAGE_ORDER[i]
      expect(at[id].x).toBe(-STAGE_WIDTHS[id] / 2)
      expect(at[id].y).toBe(prevY)
      prevY += STAGE_PITCH
    }
  })

  it('centres the stack on the origin', () => {
    const at = stageCentres()
    const sumY = STAGE_ORDER.reduce((acc, id) => acc + at[id].y, 0)
    expect(sumY / N).toBe(0)
    for (const id of STAGE_ORDER) {
      expect(at[id].x).toBe(0)
    }
  })

  it('leaves no two cards overlapping', () => {
    const at = stagePositions()
    for (let i = 1; i < N; i += 1) {
      const a = at[STAGE_ORDER[i - 1]]
      const b = at[STAGE_ORDER[i]]
      expect(b.y - (a.y + STAGE_H)).toBe(STAGE_GAP)
      expect(STAGE_GAP).toBeGreaterThan(0)
    }
  })

  it('keeps the hub above the stack with a clear gap', () => {
    const hub = hubPosition()
    const first = stagePositions()[STAGE_ORDER[0]]
    expect(hub.x).toBe(-HUB_W / 2)
    expect(hub.y + HUB_H + HUB_GAP).toBe(first.y)
  })
})

describe('stageSides', () => {
  it('runs the chain vertically through every card', () => {
    const sides = stageSides()
    for (const id of STAGE_ORDER) {
      expect(sides[id].in).toBe('top')
      expect(sides[id].out).toBe('bottom')
    }
  })
})

describe('pipelineBounds', () => {
  it('encloses the hub and every card', () => {
    const b = pipelineBounds()
    const hub = hubPosition()
    const at = stagePositions()
    expect(b.x).toBeLessThanOrEqual(hub.x)
    expect(b.y).toBeLessThanOrEqual(hub.y)
    expect(b.x + b.width).toBeGreaterThanOrEqual(hub.x + HUB_W)
    expect(b.y + b.height).toBeGreaterThanOrEqual(hub.y + HUB_H)
    for (const id of STAGE_ORDER) {
      expect(at[id].x).toBeGreaterThanOrEqual(b.x)
      expect(at[id].y).toBeGreaterThanOrEqual(b.y)
      expect(at[id].x + STAGE_WIDTHS[id]).toBeLessThanOrEqual(b.x + b.width)
      expect(at[id].y + STAGE_H).toBeLessThanOrEqual(b.y + b.height)
    }
  })

  /**
   * The stack is intentionally a tall, narrow column, so the width test is the
   * easy one. 890x807 is the pipeline pane in a 1440x900 window with the
   * sidebar expanded and the stage inspector closed: 1440 - 261 (sidebar) -
   * 289 (builder rail), by 900 - 93 (page header).
   */
  it('fits a 1440px window at zoom 1', () => {
    const b = pipelineBounds()
    expect(b.width).toBeLessThanOrEqual(890)
    expect(b.height).toBeLessThanOrEqual(807)
  })

  it('is just the hub when there are no stages', () => {
    expect(pipelineBounds([])).toEqual({
      x: -HUB_W / 2, y: hubPosition().y, width: HUB_W, height: HUB_H,
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
    expect(featureFanPositions(FEATURE_FAN_MAX)).toHaveLength(FEATURE_FAN_MAX)
    expect(featureFanPositions(99)).toHaveLength(FEATURE_FAN_MAX)
  })

  it('reads top to bottom, at the pitch that makes overlap impossible', () => {
    const at = featureFanCentres(FEATURE_FAN_MAX)
    for (let i = 1; i < at.length; i += 1) {
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
   * The chips sit in a column to the right of the stage stack. The check is
   * purely horizontal: the stack and the chips must not share the same x band.
   */
  it('clears every card and the hub horizontally, at full size', () => {
    const chips = featureFanCentres(FEATURE_FAN_MAX)
    const stackRight = STAGE_W / 2
    const hubRight = HUB_W / 2
    for (const chip of chips) {
      const leftEdge = chip.x - FEATURE_CHIP_W / 2
      expect(leftEdge).toBeGreaterThan(stackRight)
      expect(leftEdge).toBeGreaterThan(hubRight)
    }
  })

  it('hangs off the features card: outside it, and never far from it', () => {
    const features = stageCentres().features
    for (const chip of featureFanCentres(FEATURE_FAN_MAX)) {
      expect(chip.x).toBeGreaterThan(features.x)
      expect(Math.hypot(chip.x - features.x, chip.y - features.y)).toBeLessThan(260)
    }
  })
})

describe('pipelineBoundsWith', () => {
  it('is the stack itself when a strategy has no custom columns', () => {
    expect(pipelineBoundsWith(0)).toEqual(pipelineBounds())
  })

  /**
   * The fan may not cost the canvas its fit. 1045x947 is the 890x807 pane at the
   * 0.85 zoom floor (`FIT.minZoom` in PipelineCanvas) -- past that the picture
   * has to be panned.
   */
  it('still fits the pane at the zoom floor, at full size', () => {
    const b = pipelineBoundsWith(FEATURE_FAN_MAX)
    expect(b.width).toBeLessThanOrEqual(1045)
    expect(b.height).toBeLessThanOrEqual(947)
  })

  it('grows the picture rightwards only', () => {
    const stack = pipelineBounds()
    const withFan = pipelineBoundsWith(FEATURE_FAN_MAX)
    expect(withFan.y).toBe(stack.y)
    expect(withFan.height).toBe(stack.height)
    expect(withFan.x).toBe(stack.x)
    expect(withFan.width).toBeGreaterThan(stack.width)
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
    expect(at[1].y - at[0].y).toBe(52)
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
   * case by case: the entire grid is right of the entire stack, so one axis
   * settles every pair.
   */
  it('clears the whole stack on one axis, at any count', () => {
    const stackRight = STAGE_W / 2
    for (let n = 1; n <= FEATURE_GRID_MAX; n += 1) {
      const leftmost = Math.min(...featureGridCentres(n).map((c) => c.x)) - FEATURE_CHIP_W / 2
      expect(leftmost).toBeGreaterThan(stackRight)
    }
  })

  it('stays inside the stack\'s vertical band, at any count', () => {
    const stack = pipelineBounds()
    for (let n = 1; n <= FEATURE_GRID_MAX; n += 1) {
      const at = featureGridCentres(n)
      expect(Math.min(...at.map((c) => c.y)) - FEATURE_CHIP_H / 2)
        .toBeGreaterThanOrEqual(stack.y)
      expect(Math.max(...at.map((c) => c.y)) + FEATURE_CHIP_H / 2)
        .toBeLessThanOrEqual(stack.y + stack.height)
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
        if (ys.length < (byColumn.get([...byColumn.keys()][0])?.length ?? 0)) continue
        const mean = ys.reduce((a, b) => a + b, 0) / ys.length
        expect(Math.abs(mean - features.y)).toBeLessThanOrEqual(0.5)
      }
    }
  })

  /**
   * The first column of the expanded grid sits at the same x as the collapsed
   * fan and is centred on the features card the same way, so short lists do not
   * move when they expand.
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
  it('is the stack itself when a strategy has no custom columns', () => {
    expect(pipelineBoundsWith(0, true)).toEqual(pipelineBounds())
  })

  it('is four columns wide when the grid is full', () => {
    expect(pipelineBoundsWith(FEATURE_GRID_MAX, true))
      .toEqual({ x: -90, y: -404, width: 888, height: 704 })
  })

  it('still grows the picture rightwards only, at any count', () => {
    const stack = pipelineBounds()
    for (let n = 1; n <= FEATURE_GRID_MAX; n += 1) {
      const b = pipelineBoundsWith(n, true)
      expect(b.y).toBe(stack.y)
      expect(b.height).toBe(stack.height)
      expect(b.x).toBe(stack.x)
      expect(b.width).toBeGreaterThanOrEqual(stack.width)
    }
  })
})

describe('featureBlockBounds', () => {
  it('always frames the features card, never the chips alone', () => {
    const at = stageCentres().features
    const featuresW = STAGE_WIDTHS.features
    for (const expanded of [false, true]) {
      for (const n of [0, 1, FEATURE_FAN_MAX]) {
        const b = featureBlockBounds(n, expanded)
        expect(b.x).toBeLessThanOrEqual(at.x - featuresW / 2)
        expect(b.y).toBeLessThanOrEqual(at.y - STAGE_H / 2)
        expect(b.x + b.width).toBeGreaterThanOrEqual(at.x + featuresW / 2)
        expect(b.y + b.height).toBeGreaterThanOrEqual(at.y + STAGE_H / 2)
      }
    }
  })

  /**
   * The reason expanding frames this box instead of the whole picture.
   *
   * The stack plus a full grid is taller than the pane, but this box frames only
   * the features card and its chips, so it never needs less than the 0.85 zoom
   * floor.
   */
  it('fits the pane above the zoom floor, at every count', () => {
    const pad = (v: number) => 2 * Math.floor((v - v / 1.08) * 0.5)
    for (let n = 1; n <= FEATURE_GRID_MAX; n += 1) {
      const b = featureBlockBounds(n, true)
      const zoom = Math.min((890 - pad(890)) / b.width, (807 - pad(807)) / b.height)
      expect(zoom).toBeGreaterThanOrEqual(0.85)
    }
  })

  it('takes its chips from whichever shape is showing', () => {
    // A count that wraps into two columns when expanded is genuinely different…
    expect(featureChipPositions(12, false)).not.toEqual(featureChipPositions(12, true))
    // …but a count that fits in one column is identical in both shapes.
    expect(featureBlockBounds(FEATURE_FAN_MAX, false))
      .toEqual(featureBlockBounds(FEATURE_FAN_MAX, true))
    expect(featureBlockBounds(12, true).width)
      .toBeGreaterThan(featureBlockBounds(FEATURE_FAN_MAX, true).width)
  })
})
