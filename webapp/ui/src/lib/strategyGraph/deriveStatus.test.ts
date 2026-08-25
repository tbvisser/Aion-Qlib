import { describe, expect, it } from 'vitest'

import type { SpecDefect } from '@/lib/api'
import type { FeatureDraft, FeatureIssue } from '@/lib/factorExpr/featureSet'
import { deriveStatus, stageBlockingMessages } from './deriveStatus'

const column = (over: Partial<FeatureDraft> = {}): FeatureDraft => ({
  id: 'c1', name: 'MOM20', expression: 'Ref($close, -20)', complete: true, ...over,
})

const defect = (over: Partial<SpecDefect> = {}): SpecDefect => ({
  code: 'unknown-universe',
  message: 'Universe "sp500" is not in this store.',
  path: 'universe',
  severity: 'blocking',
  ...over,
})

const empty = {
  features: [] as FeatureDraft[],
  issues: [] as FeatureIssue[],
  defects: undefined,
  warnings: [] as string[],
  coverage: undefined,
}

describe('deriveStatus', () => {
  it('routes a server defect by its path and counts it as a blocker', () => {
    const d = deriveStatus({ ...empty, defects: [defect()] })
    expect(d.blockers).toEqual(['Universe "sp500" is not in this store.'])
    expect(d.status.universe.status).toBe('blocked')
    expect(d.unrouted).toEqual([])
  })

  it('keeps advisories out of the blocker count but on the card', () => {
    const d = deriveStatus({
      ...empty,
      defects: [defect({ severity: 'advisory' })],
    })
    expect(d.blockers).toEqual([])
    expect(d.status.universe.status).toBe('attention')
    expect(d.status.universe.advisories).toHaveLength(1)
  })

  it('falls back to the prefix tables when the server sent no defects', () => {
    const d = deriveStatus({
      ...empty,
      warnings: ['Test overlaps validation — results would be optimistic.'],
    })
    expect(d.status.periods.status).toBe('blocked')
    expect(d.blockers).toHaveLength(1)
  })

  it('surfaces a warning no rule claims page-level rather than dropping it', () => {
    const d = deriveStatus({
      ...empty,
      warnings: ['A sentence a future server invented.'],
    })
    expect(d.unrouted).toEqual(['A sentence a future server invented.'])
  })

  it('merges a canvas error with the defects and names its column', () => {
    const d = deriveStatus({
      ...empty,
      defects: [],
      issues: [{
        columnId: 'c1', level: 'error', code: 'duplicate-name',
        message: 'Two columns are both named MOM20.',
      }],
      features: [column()],
    })
    expect(d.blockers).toEqual(['Two columns are both named MOM20.'])
    expect(d.status.features.status).toBe('blocked')
  })

  it('ignores canvas warnings — only errors block', () => {
    const d = deriveStatus({
      ...empty,
      defects: [],
      issues: [{
        columnId: 'c1', level: 'warning', code: 'incomplete',
        message: 'MOM20 is unfinished.',
      }],
      features: [column()],
    })
    expect(d.blockers).toEqual([])
  })

  it('counts unfinished columns and reports them as a features advisory', () => {
    const d = deriveStatus({ ...empty, features: [column({ complete: false })] })
    expect(d.unfinished).toHaveLength(1)
    expect(d.status.features.status).toBe('attention')
  })
})

describe('stageBlockingMessages', () => {
  const routed = deriveStatus({ ...empty, defects: [defect()] }).routed

  it('returns the selected stage\'s blockers', () => {
    expect(stageBlockingMessages(routed, 'universe', new Set()))
      .toEqual(['Universe "sp500" is not in this store.'])
  })

  it('omits what the field\'s own control already shows', () => {
    expect(stageBlockingMessages(routed, 'universe', new Set(['universe']))).toEqual([])
  })

  it('returns nothing when no stage is selected', () => {
    expect(stageBlockingMessages(routed, null, new Set())).toEqual([])
  })
})
