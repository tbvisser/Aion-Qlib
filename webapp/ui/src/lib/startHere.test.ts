import { describe, expect, it } from 'vitest'

import type { TemplateEntry } from './api'
import { EXAMPLES, pickStarters } from './startHere'

const template = (
  id: string, family: string, runnable = true,
): TemplateEntry => ({
  id,
  title: id,
  family,
  tags: [],
  rationale: '',
  good_for: [],
  bad_for: [],
  runnable,
  blocked_by: [],
})

const ids = (list: TemplateEntry[]) => list.map((t) => t.id)

describe('pickStarters', () => {
  it('takes one per family before taking a second from any', () => {
    const picked = pickStarters([
      template('mom-a', 'momentum'),
      template('mom-b', 'momentum'),
      template('rev-a', 'reversal'),
      template('qual-a', 'quality'),
    ], 3)
    expect(ids(picked)).toEqual(['mom-a', 'rev-a', 'qual-a'])
  })

  it('prefers a runnable card over an unrunnable one from an earlier family', () => {
    // Server order puts the broken momentum template first. A front door whose
    // first click is a card that cannot run is a worse front door.
    const picked = pickStarters([
      template('mom-broken', 'momentum', false),
      template('rev-ok', 'reversal'),
    ], 1)
    expect(ids(picked)).toEqual(['rev-ok'])
  })

  it('shows an unrunnable card rather than nothing', () => {
    // Not filtered out: the card's popover is where its `blocked_by` reasons
    // are written, and an empty panel explains nothing at all.
    const picked = pickStarters([template('mom-broken', 'momentum', false)], 4)
    expect(ids(picked)).toEqual(['mom-broken'])
  })

  it('backfills a second card from a family once every family has one', () => {
    const picked = pickStarters([
      template('mom-a', 'momentum'),
      template('mom-b', 'momentum'),
      template('rev-a', 'reversal'),
    ], 3)
    expect(ids(picked)).toEqual(['mom-a', 'rev-a', 'mom-b'])
  })

  it('never returns a card twice', () => {
    const picked = pickStarters([
      template('mom-a', 'momentum'),
      template('rev-a', 'reversal'),
    ], 10)
    expect(ids(picked)).toEqual(['mom-a', 'rev-a'])
    expect(new Set(ids(picked)).size).toBe(picked.length)
  })

  it('returns fewer than asked when the catalog is smaller, without padding', () => {
    expect(pickStarters([template('only', 'momentum')], 4)).toHaveLength(1)
    expect(pickStarters([], 4)).toEqual([])
  })

  it('returns nothing for a non-positive count', () => {
    expect(pickStarters([template('a', 'momentum')], 0)).toEqual([])
    expect(pickStarters([template('a', 'momentum')], -1)).toEqual([])
  })

  it('leaves the model-comparison family to ML Studio', () => {
    // "CatBoost, same everything else" is a learner swapped into an existing
    // strategy — the question ML Studio now answers across several models at
    // once. As a front-door card it would put the choice of model back in
    // front of the idea, which is the arrangement this whole change undoes.
    const picked = pickStarters([
      template('catboost-baseline', 'model-comparison'),
      template('broad-baseline', 'baseline'),
    ], 4)
    expect(ids(picked)).toEqual(['broad-baseline'])
  })

  it('would rather show nothing than offer a model swap as a starting point', () => {
    expect(pickStarters([template('xgboost-baseline', 'model-comparison')], 4)).toEqual([])
  })

  it('preserves the server family order rather than sorting', () => {
    // The backend decides which family a beginner meets first. Alphabetising
    // here would silently override that.
    const picked = pickStarters([
      template('zeta', 'zzz'),
      template('alpha', 'aaa'),
    ], 2)
    expect(ids(picked)).toEqual(['zeta', 'alpha'])
  })
})

describe('EXAMPLES', () => {
  it('are sent verbatim, so they carry no "Try:" framing or quotes', () => {
    for (const example of EXAMPLES) {
      expect(example).not.toMatch(/^["'“]|^Try\b/i)
    }
  })

  it('covers both starting fresh and changing what is on screen', () => {
    // The box appears on an empty builder but the same phrasings are offered
    // in the dock beside a filled one, so at least one must be a modification.
    expect(EXAMPLES.some((e) => /^(start|momentum)/i.test(e))).toBe(true)
    expect(EXAMPLES.some((e) => /\bthis\b/i.test(e))).toBe(true)
  })
})
