import { describe, expect, it } from 'vitest'

import { pipelineWidth, STAGE_GAP, STAGE_W, stagePositions } from './layout'
import { STAGE_ORDER } from './stages'

describe('stagePositions', () => {
  it('is deterministic — the same spec always draws the same picture', () => {
    expect(stagePositions()).toEqual(stagePositions())
  })

  it('places one card per stage', () => {
    expect(Object.keys(stagePositions()).sort()).toEqual([...STAGE_ORDER].sort())
  })

  it('runs left to right on one row', () => {
    const at = stagePositions()
    const xs = STAGE_ORDER.map((id) => at[id].x)
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]).toBeGreaterThan(xs[i - 1])
    for (const id of STAGE_ORDER) expect(at[id].y).toBe(0)
  })

  it('holds an exact pitch, so cards can never overlap', () => {
    const at = stagePositions()
    for (let i = 1; i < STAGE_ORDER.length; i += 1) {
      const gap = at[STAGE_ORDER[i]].x - at[STAGE_ORDER[i - 1]].x
      expect(gap).toBe(STAGE_W + STAGE_GAP)
      expect(gap).toBeGreaterThanOrEqual(STAGE_W)
    }
  })

  it('starts at the origin', () => {
    expect(stagePositions()[STAGE_ORDER[0]]).toEqual({ x: 0, y: 0 })
  })
})

describe('pipelineWidth', () => {
  it('spans the first card to the last', () => {
    const at = stagePositions()
    const last = STAGE_ORDER[STAGE_ORDER.length - 1]
    expect(pipelineWidth()).toBe(at[last].x + STAGE_W)
  })

  it('is zero for an empty chain', () => {
    expect(pipelineWidth([])).toBe(0)
  })
})
