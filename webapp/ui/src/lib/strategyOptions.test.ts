import { describe, expect, it } from 'vitest'

import { DEFAULT_STRATEGY, type FieldOption, type FieldOptions, type SpecDefect } from '@/lib/api'
import {
  boundsFor, defectsFor, fieldOf, noteFor, optionsFor, quarantined, resolutions,
} from '@/lib/strategyOptions'

function option(value: string, over: Partial<FieldOption> = {}): FieldOption {
  return { value, label: value, enabled: true, reason: null, fix: null, ...over }
}

function defect(path: string, over: Partial<SpecDefect> = {}): SpecDefect {
  return { code: 'x', message: `about ${path}`, path, severity: 'blocking', ...over }
}

/** The crypto/SPY case, which is the one that cost a five-minute run. */
const CRYPTO: Record<string, FieldOptions> = {
  benchmark: {
    options: [
      option('SPY', {
        enabled: false,
        reason: 'Not in the crypto_365 store, so there is nothing to compare returns against.',
        fix: { path: 'data_store', value: 'us', label: 'Switch to the us store' },
      }),
      option('BTC-USD'),
      option('ETH-USD'),
    ],
    bounds: null,
    note: 'This store ships no benchmark list, so these are the crypto_top100 names.',
  },
  topk: { options: [], bounds: { min: 1, max: 500 }, note: null },
}

const SPEC = { ...DEFAULT_STRATEGY, data_store: 'crypto_365' as const, benchmark: 'SPY' }

describe('fieldOf', () => {
  it('is the field itself when the path is only a field', () => {
    expect(fieldOf('benchmark')).toBe('benchmark')
  })

  // The detail is what lets a message point at one custom column rather than
  // at the Features stage in general, so it has to survive on the path while
  // routing still keys on the leading segment.
  it.each([
    ['features[2].name', 'features'],
    ['features[0].expression', 'features'],
    ['features', 'features'],
  ])('reduces %s to %s', (path, field) => {
    expect(fieldOf(path)).toBe(field)
  })
})

describe('quarantined', () => {
  it('is the fields a run would be refused for', () => {
    expect([...quarantined([defect('benchmark'), defect('universe')])])
      .toEqual(['benchmark', 'universe'])
  })

  // A run that finishes and means nothing is a legitimate thing to ask for.
  // Marking those fields as broken is how a reader learns to ignore the marks.
  it('ignores advisories', () => {
    expect(quarantined([defect('topk', { severity: 'advisory' })]).size).toBe(0)
  })

  it('collapses several defects on one field', () => {
    expect(quarantined([defect('features[0].name'), defect('features[1].expression')]))
      .toEqual(new Set(['features']))
  })
})

describe('defectsFor', () => {
  it('keeps both severities, in server order', () => {
    const all = [defect('topk', { severity: 'advisory' }), defect('benchmark')]
    expect(defectsFor(all, 'topk')).toHaveLength(1)
    expect(defectsFor(all, 'benchmark')[0].severity).toBe('blocking')
  })
})

describe('optionsFor', () => {
  it('passes the server list through, disabled entries and all', () => {
    const out = optionsFor(CRYPTO, 'benchmark', 'SPY')
    expect(out.map((o) => o.value)).toEqual(['SPY', 'BTC-USD', 'ETH-USD'])
    expect(out[0].enabled).toBe(false)
  })

  // A select whose value is not among its options renders blank, which reads
  // as "nothing is chosen" — worst on the one field an import most needs seen.
  it('inserts the current value when the list does not carry it', () => {
    const out = optionsFor(CRYPTO, 'benchmark', 'QQQ')
    expect(out[0].value).toBe('QQQ')
    expect(out).toHaveLength(4)
  })

  it('falls back to the caller list when the server sent no options', () => {
    expect(optionsFor(undefined, 'model', 'lightgbm', ['lightgbm', 'xgboost'])
      .map((o) => o.value)).toEqual(['lightgbm', 'xgboost'])
  })

  it('still shows the current value against an empty server', () => {
    expect(optionsFor(undefined, 'model', 'catboost').map((o) => o.value)).toEqual(['catboost'])
  })

  it('does not duplicate a current value the list already has', () => {
    expect(optionsFor(CRYPTO, 'benchmark', 'BTC-USD')).toHaveLength(3)
  })
})

describe('boundsFor and noteFor', () => {
  it('read the bounds the server took off the model', () => {
    expect(boundsFor(CRYPTO, 'topk')).toEqual({ min: 1, max: 500 })
  })

  it('are null rather than undefined when absent', () => {
    expect(boundsFor(CRYPTO, 'benchmark')).toBeNull()
    expect(noteFor(undefined, 'benchmark')).toBeNull()
  })

  it('carry the note that stops a narrowed list reading as the whole truth', () => {
    expect(noteFor(CRYPTO, 'benchmark')).toContain('no benchmark list')
  })
})

describe('resolutions', () => {
  const defects = [defect('benchmark', { code: 'unknown_benchmark' })]

  it('is empty for a field that is fine', () => {
    expect(resolutions('universe', SPEC, CRYPTO, defects)).toEqual([])
  })

  it('is empty when the field is only advisory', () => {
    expect(resolutions('topk', SPEC, CRYPTO,
                       [defect('topk', { severity: 'advisory' })])).toEqual([])
  })

  // The two shapes of answer, and the trade between them. This is the whole
  // reason an import marks a field instead of repairing it: only the reader
  // knows which half they meant.
  it('offers both changing the field and changing what invalidated it', () => {
    const out = resolutions('benchmark', SPEC, CRYPTO, defects)

    expect(out.map((r) => r.label)).toEqual([
      'Use BTC-USD', 'Use ETH-USD', 'Switch to the us store',
    ])
    expect(out[0].patch).toEqual({ benchmark: 'BTC-USD' })
    expect(out[2].patch).toEqual({ data_store: 'us' })
  })

  it('names what each one preserves, in the reader’s own values', () => {
    const out = resolutions('benchmark', SPEC, CRYPTO, defects)

    expect(out[0].preserves).toBe('keeps crypto_365 as the store')
    expect(out[2].preserves).toBe('keeps SPY as the benchmark')
  })

  it('offers only value changes when the server named no cause', () => {
    const noFix = {
      benchmark: { options: [option('SPY', { enabled: false }), option('BTC-USD')],
                   bounds: null, note: null },
    }
    const out = resolutions('benchmark', SPEC, noFix, defects)

    expect(out).toHaveLength(1)
    expect(out[0].preserves).toBe('')
  })

  it('never offers the value that is already set', () => {
    const out = resolutions('benchmark', { ...SPEC, benchmark: 'BTC-USD' }, CRYPTO, defects)
    expect(out.every((r) => r.patch.benchmark !== 'BTC-USD')).toBe(true)
  })
})
