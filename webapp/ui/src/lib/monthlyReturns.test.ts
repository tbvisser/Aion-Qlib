import { describe, expect, it } from 'vitest'

import { monthlyReturns } from './monthlyReturns'
import type { CurvePoint } from './api'

const p = (date: string, value: number | null): CurvePoint => ({ date, value })

describe('monthlyReturns', () => {
  it('de-cumulates geometrically, not by subtraction', () => {
    // Three months of exactly +10% each, compounded: 0.10, 0.21, 0.331.
    const [row] = monthlyReturns([
      p('2024-01-31', 0.1),
      p('2024-02-29', 0.21),
      p('2024-03-31', 0.331),
    ])

    for (const cell of row.months) expect(cell.value).toBeCloseTo(0.1, 10)
    // Subtraction would have given 0.10 / 0.11 / 0.121 — plausible, and wrong.
    expect(row.months[1].value).not.toBeCloseTo(0.11, 4)
  })

  it('compounds the year total back to the curve it came from', () => {
    const [row] = monthlyReturns([
      p('2024-01-31', 0.05),
      p('2024-06-30', -0.02),
      p('2024-12-31', 0.18),
    ])
    expect(row.total).toBeCloseTo(0.18, 10)
  })

  it('carries wealth across the year boundary', () => {
    const rows = monthlyReturns([
      p('2023-12-31', 0.2),
      p('2024-01-31', 0.32),
    ])
    expect(rows).toHaveLength(2)
    // 1.32 / 1.20 - 1 = 10%, not the 12 points the cumulative curve moved.
    expect(rows[1].months[0].value).toBeCloseTo(0.1, 10)
  })

  it('takes the last observation in a month, not the first', () => {
    const [row] = monthlyReturns([
      p('2024-01-05', 0.5),
      p('2024-01-31', 0.02),
    ])
    expect(row.months).toHaveLength(1)
    expect(row.months[0].value).toBeCloseTo(0.02, 10)
  })

  it('treats the first month as measured from zero', () => {
    const [row] = monthlyReturns([p('2024-01-31', 0.07)])
    expect(row.months[0].value).toBeCloseTo(0.07, 10)
  })

  it('skips null values and empty curves', () => {
    expect(monthlyReturns([])).toEqual([])
    expect(monthlyReturns([p('2024-01-31', null)])).toEqual([])

    const [row] = monthlyReturns([p('2024-01-31', null), p('2024-02-29', 0.04)])
    expect(row.months).toHaveLength(1)
    expect(row.months[0].month).toBe(1)
  })
})
