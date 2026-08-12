import { describe, expect, it } from 'vitest'

import { nextCopyName } from './strategyNames'

describe('nextCopyName', () => {
  it('appends copy when nothing collides', () => {
    expect(nextCopyName('Momentum v3', [])).toBe('Momentum v3 copy')
  })

  it('numbers from 2 once the plain copy is taken', () => {
    expect(nextCopyName('Momentum v3', ['Momentum v3 copy'])).toBe('Momentum v3 copy 2')
    expect(nextCopyName('Momentum v3', ['Momentum v3 copy', 'Momentum v3 copy 2']))
      .toBe('Momentum v3 copy 3')
  })

  it('fills a gap rather than always taking the next number', () => {
    expect(nextCopyName('Momentum v3', ['Momentum v3 copy', 'Momentum v3 copy 3']))
      .toBe('Momentum v3 copy 2')
  })

  /** Otherwise a third duplicate is called "X copy copy copy". */
  it('does not stack suffixes when duplicating a duplicate', () => {
    expect(nextCopyName('Momentum v3 copy', ['Momentum v3 copy'])).toBe('Momentum v3 copy 2')
    expect(nextCopyName('Momentum v3 copy 2', ['Momentum v3 copy', 'Momentum v3 copy 2']))
      .toBe('Momentum v3 copy 3')
  })

  it('ignores surrounding whitespace on both sides', () => {
    expect(nextCopyName('  Momentum v3  ', ['Momentum v3 copy '])).toBe('Momentum v3 copy 2')
  })

  it('names an unnamed strategy rather than producing a bare " copy"', () => {
    expect(nextCopyName('   ', [])).toBe('New strategy copy')
  })

  /** The server caps `name` at 80 characters; a duplicate that 422s is a worse answer. */
  it('truncates instead of overflowing the server limit', () => {
    const long = 'x'.repeat(78)
    const result = nextCopyName(long, [])
    expect(result.length).toBeLessThanOrEqual(80)
    expect(result.startsWith(long)).toBe(true)
  })
})
