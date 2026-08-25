import { describe, expect, it } from 'vitest'

import { DEFAULT_STRATEGY, type StoredStrategy } from '@/lib/api'
import { dirtyFields, isDirty, saveState } from './strategyDirty'

describe('isDirty', () => {
  it('is clean against its own baseline', () => {
    expect(isDirty(DEFAULT_STRATEGY, DEFAULT_STRATEGY)).toBe(false)
  })

  it('is clean against an equal but distinct object', () => {
    expect(isDirty({ ...DEFAULT_STRATEGY }, DEFAULT_STRATEGY)).toBe(false)
  })

  it('notices a scalar edit', () => {
    expect(isDirty({ ...DEFAULT_STRATEGY, topk: 30 }, DEFAULT_STRATEGY)).toBe(true)
  })

  /**
   * `api.ts` says these two are deliberately distinguishable — `null` is the
   * handler's own feature set untouched, `[]` is a set the backend normalises
   * back to null. Reporting them equal would let "I deleted my last column"
   * save silently as no change at all.
   */
  it('treats a null feature set and an empty one as different', () => {
    expect(isDirty({ ...DEFAULT_STRATEGY, features: [] }, DEFAULT_STRATEGY)).toBe(true)
  })

  it('notices an expression edited inside a feature column', () => {
    const before = { ...DEFAULT_STRATEGY, features: [{ name: 'MOM5', expression: '$close' }] }
    const after = { ...before, features: [{ name: 'MOM5', expression: '$open' }] }
    expect(isDirty(after, before)).toBe(true)
  })

  it('notices a reordered feature set — column order is the pandas column order', () => {
    const a = { name: 'A', expression: '$close' }
    const b = { name: 'B', expression: '$open' }
    const before = { ...DEFAULT_STRATEGY, features: [a, b] }
    expect(isDirty({ ...before, features: [b, a] }, before)).toBe(true)
  })

  it('is not fooled by a new array holding equal columns', () => {
    const before = { ...DEFAULT_STRATEGY, features: [{ name: 'A', expression: '$close' }] }
    const after = { ...before, features: [{ name: 'A', expression: '$close' }] }
    expect(isDirty(after, before)).toBe(false)
  })

  /**
   * After a save the baseline is the *server's* record, which carries id,
   * timestamps, owner and visibility the edited spec never has. Those are
   * bookkeeping, not edits: counting them made every strategy read
   * "Unsaved edits" forever from the moment it was first saved.
   */
  it('ignores server bookkeeping when the baseline is a stored record', () => {
    const stored: StoredStrategy = {
      ...DEFAULT_STRATEGY,
      id: 's1',
      created_at: '2026-08-24T00:00:00Z',
      updated_at: '2026-08-24T00:00:01Z',
      user_id: 'u1',
      visibility: 'private',
    }
    expect(isDirty(DEFAULT_STRATEGY, stored)).toBe(false)
    // Opening a saved strategy seeds the spec from the stored record; a later
    // save returns fresher timestamps. Still not an edit.
    const resaved: StoredStrategy = { ...stored, updated_at: '2026-08-24T09:00:00Z' }
    expect(isDirty(stored, resaved)).toBe(false)
    // Real edits still show through.
    expect(isDirty({ ...DEFAULT_STRATEGY, topk: 30 }, stored)).toBe(true)
  })
})

describe('dirtyFields', () => {
  it('names what changed, in spec key order', () => {
    const next = { ...DEFAULT_STRATEGY, topk: 30, universe: 'macro50', name: 'Renamed' }
    expect(dirtyFields(next, DEFAULT_STRATEGY)).toEqual(['name', 'universe', 'topk'])
  })

  it('is empty for an unedited spec', () => {
    expect(dirtyFields(DEFAULT_STRATEGY, DEFAULT_STRATEGY)).toEqual([])
  })
})

describe('saveState', () => {
  it('separates a never-saved draft from one with unsaved edits', () => {
    expect(saveState(false, 'abc123')).toBe('saved')
    expect(saveState(true, 'abc123')).toBe('unsaved-edits')
    expect(saveState(true, undefined)).toBe('never-saved')
  })

  /** A fresh builder nobody has touched has nothing to say, and should not nag. */
  it('says nothing about an untouched new draft', () => {
    expect(saveState(false, undefined)).toBe('clean-draft')
  })
})
