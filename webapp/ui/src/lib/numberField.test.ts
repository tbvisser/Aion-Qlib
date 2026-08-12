/**
 * The numeric-field parser.
 *
 * The cases that matter are the ones the old inline `Number()` got wrong:
 * `Number('') === 0` committed a zero on clear, and a typed value outside
 * `min`/`max` sailed past attributes that only constrain the spinner.
 */
import { describe, expect, it } from 'vitest'

import { parseNumberField } from './numberField'

describe('parseNumberField', () => {
  it('accepts a plain number', () => {
    expect(parseNumberField('50')).toEqual({ ok: true, value: 50 })
    expect(parseNumberField(' 2.5 ')).toEqual({ ok: true, value: 2.5 })
  })

  it('refuses an empty field rather than reading it as zero', () => {
    expect(parseNumberField('')).toEqual({ ok: false, error: 'Enter a number.' })
    expect(parseNumberField('   ')).toEqual({ ok: false, error: 'Enter a number.' })
  })

  it('refuses what Number() cannot make finite', () => {
    expect(parseNumberField('abc')).toEqual({ ok: false, error: 'Enter a number.' })
    expect(parseNumberField('Infinity')).toEqual({ ok: false, error: 'Enter a number.' })
    expect(parseNumberField('NaN')).toEqual({ ok: false, error: 'Enter a number.' })
  })

  it('holds the bounds, inclusively', () => {
    const bounds = { min: 1, max: 500 }
    expect(parseNumberField('1', bounds)).toEqual({ ok: true, value: 1 })
    expect(parseNumberField('500', bounds)).toEqual({ ok: true, value: 500 })
    expect(parseNumberField('0', bounds)).toEqual({
      ok: false, error: 'Enter a number between 1 and 500.',
    })
    expect(parseNumberField('600', bounds)).toEqual({
      ok: false, error: 'Enter a number between 1 and 500.',
    })
  })

  it('words the error for the bounds the field actually has', () => {
    expect(parseNumberField('-1', { min: 0 })).toEqual({
      ok: false, error: 'Enter a number of at least 0.',
    })
    expect(parseNumberField('600', { max: 500 })).toEqual({
      ok: false, error: 'Enter a number of 500 or less.',
    })
  })

  it('is unbounded when no bounds are given', () => {
    expect(parseNumberField('-1000000')).toEqual({ ok: true, value: -1000000 })
  })
})
