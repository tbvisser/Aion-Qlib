import { describe, expect, it } from 'vitest'

import { DEFAULT_STRATEGY } from '@/lib/api'
import { PHASE_ORDER, STAGE_ORDER, STAGES, stageOwning } from './stages'

describe('STAGE_ORDER', () => {
  it('covers every stage exactly once', () => {
    expect(new Set(STAGE_ORDER).size).toBe(STAGE_ORDER.length)
    expect([...STAGE_ORDER].sort()).toEqual(Object.keys(STAGES).sort())
  })

  it('gives every stage at least one field to own', () => {
    for (const id of STAGE_ORDER) expect(STAGES[id].owns.length).toBeGreaterThan(0)
  })

  it('declares each stage under a known phase', () => {
    for (const id of STAGE_ORDER) expect(PHASE_ORDER).toContain(STAGES[id].phase)
  })
})

describe('field ownership', () => {
  /**
   * The highest-value assertion here.
   *
   * Exploding one form into seven panels fails by dropping a field, and it
   * fails silently -- the canvas still renders, the spec still runs, and the
   * setting is simply unreachable. This is the thing that notices.
   */
  it('accounts for every builder-relevant spec field except the name', () => {
    const owned = new Set(STAGE_ORDER.flatMap((id) => STAGES[id].owns as readonly string[]))
    const expected = new Set(Object.keys(DEFAULT_STRATEGY).filter(
      (k) => k !== 'name' && k !== 'origin' && k !== 'description',
    ))
    expect([...owned].sort()).toEqual([...expected].sort())
  })

  it('never lets two stages own the same field', () => {
    const seen = STAGE_ORDER.flatMap((id) => STAGES[id].owns as readonly string[])
    expect(seen.length).toBe(new Set(seen).size)
  })

  it('does not claim the name — that is the header input, not a stage', () => {
    expect(stageOwning('name')).toBeNull()
  })

  it('resolves a field back to its stage', () => {
    expect(stageOwning('data_store')).toBe('store')
    expect(stageOwning('benchmark')).toBe('universe')
    expect(stageOwning('handler')).toBe('features')
    expect(stageOwning('test_end')).toBe('periods')
    expect(stageOwning('model')).toBe('learner')
    expect(stageOwning('n_drop')).toBe('portfolio')
    expect(stageOwning('limit_threshold')).toBe('costs')
  })
})
