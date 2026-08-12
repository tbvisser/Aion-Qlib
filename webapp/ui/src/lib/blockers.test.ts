import { describe, expect, it } from 'vitest'

import { mentionsColumn, mergeBlockers } from './blockers'

// The exact strings both sides produce, so this test breaks if either drifts.
const LOOKAHEAD = 'Ref($close, -5) reads 5 days of future data. A feature may not.'
const OVERLAP = 'Test overlaps validation — results would be optimistic.'
const CLAMP = 'Test end 2026-12-31 is past the last date this store can safely backtest; '
  + 'the run will end 2026-07-31 instead.'
const COLLISION_SERVER = 'Column `MA5` already exists in Alpha158.'
const COLLISION_CLIENT = 'MA5 is one of Alpha158\'s own columns — it would silently replace it.'

describe('mentionsColumn', () => {
  it('matches only the backticked name', () => {
    expect(mentionsColumn('`MA5` is already a column in Alpha158.', 'MA5')).toBe(true)
    expect(mentionsColumn('MA5 is already a column in Alpha158.', 'MA5')).toBe(false)
  })

  /**
   * The bug this rule exists for: a column legally named `a` matched every
   * warning containing the letter. `strategyGraph/routeWarning.ts` calls the
   * same function so it cannot reintroduce it.
   */
  it('does not let a one-letter name match a sentence containing that letter', () => {
    expect(mentionsColumn(OVERLAP, 'a')).toBe(false)
  })
})

describe('mergeBlockers', () => {
  it('keeps a window problem only the server knows about', () => {
    expect(mergeBlockers([OVERLAP, CLAMP], [])).toEqual([OVERLAP, CLAMP])
  })

  it('says an expression defect once, not twice', () => {
    // Both sides run the same `inspect_expression`, so the strings match
    // exactly — and they contain no backticks, so the name rule cannot see them.
    // This is the case the live /factors/validate wiring introduced.
    expect(LOOKAHEAD).not.toContain('`')
    expect(mergeBlockers([LOOKAHEAD], [{ message: LOOKAHEAD, columnName: 'CHEAT' }]))
      .toEqual([LOOKAHEAD])
  })

  it('suppresses a differently-worded warning about a column already flagged', () => {
    // Here the two sides disagree on wording, so identity does not help. What
    // they share is the column, which the server writes in backticks.
    expect(mergeBlockers(
      [COLLISION_SERVER],
      [{ message: COLLISION_CLIENT, columnName: 'MA5' }],
    )).toEqual([COLLISION_CLIENT])
  })

  it('does not let a short column name swallow unrelated warnings', () => {
    // The bug the backtick rule exists for: a bare substring match meant a
    // column named `a` matched every warning containing the letter.
    const merged = mergeBlockers(
      [OVERLAP], [{ message: 'a is not a useful name', columnName: 'a' }])
    expect(merged).toContain(OVERLAP)
  })

  it('keeps both when they are about different columns', () => {
    const merged = mergeBlockers(
      ['Column `MOM` already exists in Alpha158.'],
      [{ message: COLLISION_CLIENT, columnName: 'MA5' }],
    )
    expect(merged).toHaveLength(2)
  })

  it('puts the surviving server warnings before the canvas issues', () => {
    expect(mergeBlockers([OVERLAP], [{ message: LOOKAHEAD, columnName: 'C' }]))
      .toEqual([OVERLAP, LOOKAHEAD])
  })

  it('handles issues with no column at all', () => {
    // Set-level issues — an empty replace-mode feature set — name nothing.
    expect(mergeBlockers([OVERLAP], [{ message: 'Replace mode needs a column.' }]))
      .toEqual([OVERLAP, 'Replace mode needs a column.'])
  })

  it('is empty when nothing is wrong', () => {
    expect(mergeBlockers([], [])).toEqual([])
  })

  it('does not deduplicate two genuinely distinct problems', () => {
    expect(mergeBlockers([OVERLAP, CLAMP], [{ message: LOOKAHEAD, columnName: 'C' }]))
      .toHaveLength(3)
  })
})
