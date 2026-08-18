import { describe, expect, it } from 'vitest'
import { isNodeConfigComplete, normaliseCategory, NODE_CATEGORY_INFO } from './nodeRegistry'

describe('normaliseCategory', () => {
  it('maps backend lowercase categories to frontend title-case keys', () => {
    expect(normaliseCategory('data')).toBe('Data')
    expect(normaliseCategory('rules')).toBe('Rules')
    expect(normaliseCategory('execution')).toBe('Execution')
    expect(normaliseCategory('portfolio')).toBe('Portfolio')
  })

  it('leaves canonical categories untouched', () => {
    expect(normaliseCategory('Data')).toBe('Data')
    expect(normaliseCategory('Schedule')).toBe('Schedule')
  })

  it('returns undefined for empty input', () => {
    expect(normaliseCategory('')).toBeUndefined()
    expect(normaliseCategory(undefined)).toBeUndefined()
  })

  it('produces keys that exist in NODE_CATEGORY_INFO', () => {
    for (const raw of ['data', 'features', 'model', 'output', 'schedule']) {
      const canonical = normaliseCategory(raw)
      expect(NODE_CATEGORY_INFO[canonical!]).toBeDefined()
    }
  })
})

describe('isNodeConfigComplete', () => {
  const meta = {
    config_schema: {
      type: 'object',
      properties: {
        store: { type: 'string', enum: ['us', 'crypto_365'] },
        universe: { type: 'string' },
        topk: { type: 'number' },
        active: { type: 'boolean' },
        features: { type: 'array', items: { type: 'object' } },
        optional: { type: 'string' },
      },
      required: ['store', 'universe', 'topk', 'active', 'features'],
    },
  }

  it('returns true when all required fields are populated', () => {
    const node = {
      type: 'mock',
      config: {
        store: 'us',
        universe: 'top500',
        topk: 50,
        active: true,
        features: [{ name: 'x' }],
      },
    }
    expect(isNodeConfigComplete(node, meta)).toBe(true)
  })

  it('returns false when a required string is empty', () => {
    const node = {
      type: 'mock',
      config: { store: 'us', universe: '', topk: 50, active: true, features: [{ name: 'x' }] },
    }
    expect(isNodeConfigComplete(node, meta)).toBe(false)
  })

  it('returns false when a required number is undefined', () => {
    const node = {
      type: 'mock',
      config: { store: 'us', universe: 'top500', active: true, features: [{ name: 'x' }] },
    }
    expect(isNodeConfigComplete(node, meta)).toBe(false)
  })

  it('returns true when a required number is zero', () => {
    const node = {
      type: 'mock',
      config: { store: 'us', universe: 'top500', topk: 0, active: true, features: [{ name: 'x' }] },
    }
    expect(isNodeConfigComplete(node, meta)).toBe(true)
  })

  it('returns false when a required array is empty', () => {
    const node = {
      type: 'mock',
      config: { store: 'us', universe: 'top500', topk: 50, active: true, features: [] },
    }
    expect(isNodeConfigComplete(node, meta)).toBe(false)
  })

  it('ignores optional empty fields', () => {
    const node = {
      type: 'mock',
      config: {
        store: 'us',
        universe: 'top500',
        topk: 50,
        active: true,
        features: [{ name: 'x' }],
        optional: '',
      },
    }
    expect(isNodeConfigComplete(node, meta)).toBe(true)
  })

  it('returns true when there are no required fields', () => {
    const node = { type: 'mock', config: {} }
    expect(isNodeConfigComplete(node, { config_schema: { type: 'object', properties: {} } })).toBe(true)
  })

  it('returns true when meta has no schema', () => {
    const node = { type: 'mock', config: {} }
    expect(isNodeConfigComplete(node, undefined)).toBe(true)
  })
})
