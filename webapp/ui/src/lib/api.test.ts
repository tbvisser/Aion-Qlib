/**
 * The 422 detail parser.
 *
 * The shapes here are FastAPI's, copied from real responses rather than
 * invented: one entry per bad field, `loc` starting at "body", and custom
 * validators wrapped in "Value error, ". The parser's job is to turn that
 * into a sentence naming the field — the alternative the user actually saw
 * was "422 Unprocessable Entity".
 */
import { describe, expect, it } from 'vitest'

import { validationMessage } from './api'

describe('validationMessage', () => {
  it('names the field a constraint refused', () => {
    expect(validationMessage([
      {
        type: 'less_than_equal',
        loc: ['body', 'topk'],
        msg: 'Input should be less than or equal to 500',
        input: 600,
      },
    ])).toBe('topk: Input should be less than or equal to 500')
  })

  it('unwraps a custom validator and keeps a model-level message bare', () => {
    // A model_validator's loc is just ["body"] — there is no field to name.
    expect(validationMessage([
      {
        type: 'value_error',
        loc: ['body'],
        msg: "Value error, feature_mode 'replace' needs at least one custom feature.",
      },
    ])).toBe("feature_mode 'replace' needs at least one custom feature.")
  })

  it('keeps list indices in a nested path', () => {
    expect(validationMessage([
      { type: 'string_pattern_mismatch', loc: ['body', 'features', 0, 'name'], msg: 'String should match pattern' },
    ])).toBe('features.0.name: String should match pattern')
  })

  it('joins several problems into one message', () => {
    expect(validationMessage([
      { loc: ['body', 'topk'], msg: 'Input should be greater than or equal to 1' },
      { loc: ['body', 'test_end'], msg: "Value error, '' must be YYYY-MM-DD" },
    ])).toBe(
      "topk: Input should be greater than or equal to 1 test_end: '' must be YYYY-MM-DD",
    )
  })

  it('skips malformed entries rather than crashing on them', () => {
    expect(validationMessage([
      null,
      'not an object',
      { loc: ['body', 'topk'] }, // no msg
      { loc: ['body', 'n_drop'], msg: 'Input should be less than or equal to 100' },
    ])).toBe('n_drop: Input should be less than or equal to 100')
  })

  it('returns null when nothing usable survives', () => {
    expect(validationMessage([])).toBeNull()
    expect(validationMessage([{ loc: ['body'] }])).toBeNull()
    expect(validationMessage('a plain string')).toBeNull()
    expect(validationMessage({ message: 'structured refusal' })).toBeNull()
    expect(validationMessage(undefined)).toBeNull()
  })
})
