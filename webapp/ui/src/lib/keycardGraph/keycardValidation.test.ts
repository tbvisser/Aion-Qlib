import { describe, expect, it } from 'vitest'
import type { KeycardNodeTypeMeta } from '@/lib/api'
import { missingRequiredCategories } from './keycardValidation'

function makeMeta(category: string): KeycardNodeTypeMeta {
  return {
    id: 'mock',
    category,
    label: 'Mock',
    icon: 'box',
    description: '',
    ports: [],
    config_schema: {},
  } as KeycardNodeTypeMeta
}

describe('missingRequiredCategories', () => {
  it('accepts a complete quant pipeline without Schedule/Rules', () => {
    const meta = new Map<string, KeycardNodeTypeMeta>([
      ['data_store', makeMeta('Data')],
      ['universe', makeMeta('Data')],
      ['handler', makeMeta('Features')],
      ['model', makeMeta('Model')],
      ['portfolio', makeMeta('Portfolio')],
      ['costs', makeMeta('Execution')],
      ['records', makeMeta('Output')],
    ])
    const nodes = Array.from(meta.keys()).map((type) => ({ type }))
    expect(missingRequiredCategories(nodes, meta)).toEqual([])
  })

  it('flags a quant pipeline missing Model', () => {
    const meta = new Map<string, KeycardNodeTypeMeta>([
      ['data_store', makeMeta('Data')],
      ['handler', makeMeta('Features')],
      ['portfolio', makeMeta('Portfolio')],
      ['records', makeMeta('Output')],
    ])
    const nodes = Array.from(meta.keys()).map((type) => ({ type }))
    expect(missingRequiredCategories(nodes, meta)).toContain('Model')
  })

  it('accepts a complete rule workflow', () => {
    const meta = new Map<string, KeycardNodeTypeMeta>([
      ['run_per_candle', makeMeta('Schedule')],
      ['previous_day_bullish', makeMeta('Rules')],
      ['buy_now', makeMeta('Execution')],
      ['portfolio', makeMeta('Portfolio')],
      ['costs', makeMeta('Execution')],
      ['records', makeMeta('Output')],
    ])
    const nodes = Array.from(meta.keys()).map((type) => ({ type }))
    expect(missingRequiredCategories(nodes, meta)).toEqual([])
  })

  it('flags a rule workflow missing Rules', () => {
    const meta = new Map<string, KeycardNodeTypeMeta>([
      ['run_per_candle', makeMeta('Schedule')],
      ['buy_now', makeMeta('Execution')],
      ['portfolio', makeMeta('Portfolio')],
      ['records', makeMeta('Output')],
    ])
    const nodes = Array.from(meta.keys()).map((type) => ({ type }))
    expect(missingRequiredCategories(nodes, meta)).toContain('Rules')
  })

  it('does not switch to rule mode just because a costs node is present', () => {
    // This is the regression case: a quant pipeline contains "costs" (Execution),
    // which used to be mis-detected as a rule workflow.
    const meta = new Map<string, KeycardNodeTypeMeta>([
      ['data_store', makeMeta('Data')],
      ['universe', makeMeta('Data')],
      ['handler', makeMeta('Features')],
      ['model', makeMeta('Model')],
      ['portfolio', makeMeta('Portfolio')],
      ['costs', makeMeta('Execution')],
      ['records', makeMeta('Output')],
    ])
    const nodes = Array.from(meta.keys()).map((type) => ({ type }))
    const missing = missingRequiredCategories(nodes, meta)
    expect(missing).not.toContain('Schedule')
    expect(missing).not.toContain('Rules')
  })

  it('normalises backend lowercase categories to frontend title-case', () => {
    // The /api/keycards/node-types endpoint returns categories in lowercase;
    // the frontend NodeCategory union uses title-case. Missing-category detection
    // must treat "data" and "Data" as the same bucket.
    const meta = new Map<string, KeycardNodeTypeMeta>([
      ['data_store', makeMeta('data')],
      ['universe', makeMeta('data')],
      ['handler', makeMeta('features')],
      ['model', makeMeta('model')],
      ['portfolio', makeMeta('portfolio')],
      ['costs', makeMeta('execution')],
      ['records', makeMeta('output')],
    ])
    const nodes = Array.from(meta.keys()).map((type) => ({ type }))
    expect(missingRequiredCategories(nodes, meta)).toEqual([])
  })
})
