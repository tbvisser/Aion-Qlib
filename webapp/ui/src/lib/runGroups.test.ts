import { describe, expect, it } from 'vitest'

import type { Run } from '@/lib/api'
import { groupRuns } from './runGroups'

const run = (over: Partial<Run> & Pick<Run, 'id' | 'name'>): Run => ({
  kind: 'backtest',
  status: 'succeeded',
  phase: 'Finished',
  created_at: '2026-08-11T00:00:00Z',
  started_at: '2026-08-11T00:00:01Z',
  finished_at: '2026-08-11T00:05:00Z',
  exit_code: 0,
  error: null,
  experiment_name: `aion-${over.id}`,
  ...over,
})

describe('groupRuns', () => {
  it('gathers runs of one saved strategy together', () => {
    const groups = groupRuns([
      run({ id: 'r1', name: 'Momentum v3', strategy_id: 's1' }),
      run({ id: 'r2', name: 'Momentum v3', strategy_id: 's1' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 's1', label: 'Momentum v3' })
    expect(groups[0].runs.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  /** Unsaved runs carry no id; one "unsaved" heading would file unrelated ideas together. */
  it('falls back to the name for runs started before a strategy was saved', () => {
    const groups = groupRuns([
      run({ id: 'r1', name: 'Momentum idea' }),
      run({ id: 'r2', name: 'Momentum idea' }),
      run({ id: 'r3', name: 'Reversion idea' }),
    ])
    expect(groups.map((g) => g.key)).toEqual(['Momentum idea', 'Reversion idea'])
    expect(groups[0].runs).toHaveLength(2)
  })

  /** Two saved strategies may share a name; the id is what keeps them apart. */
  it('keeps two saved strategies with the same name separate', () => {
    const groups = groupRuns([
      run({ id: 'r1', name: 'Momentum', strategy_id: 's1' }),
      run({ id: 'r2', name: 'Momentum', strategy_id: 's2' }),
    ])
    expect(groups.map((g) => g.key)).toEqual(['s1', 's2'])
  })

  it('preserves the order runs arrived in, within a group and between groups', () => {
    const groups = groupRuns([
      run({ id: 'r1', name: 'B', strategy_id: 's2' }),
      run({ id: 'r2', name: 'A', strategy_id: 's1' }),
      run({ id: 'r3', name: 'B', strategy_id: 's2' }),
    ])
    expect(groups.map((g) => g.key)).toEqual(['s2', 's1'])
    expect(groups[0].runs.map((r) => r.id)).toEqual(['r1', 'r3'])
  })

  it('floats the open strategy to the top without disturbing the rest', () => {
    const runs = [
      run({ id: 'r1', name: 'A', strategy_id: 's1' }),
      run({ id: 'r2', name: 'B', strategy_id: 's2' }),
      run({ id: 'r3', name: 'C', strategy_id: 's3' }),
    ]
    expect(groupRuns(runs, 's3').map((g) => g.key)).toEqual(['s3', 's1', 's2'])
  })

  it('leaves the order alone when the open strategy is already first, or has no runs', () => {
    const runs = [
      run({ id: 'r1', name: 'A', strategy_id: 's1' }),
      run({ id: 'r2', name: 'B', strategy_id: 's2' }),
    ]
    expect(groupRuns(runs, 's1').map((g) => g.key)).toEqual(['s1', 's2'])
    expect(groupRuns(runs, 'never-run').map((g) => g.key)).toEqual(['s1', 's2'])
    expect(groupRuns(runs).map((g) => g.key)).toEqual(['s1', 's2'])
  })

  it('is empty for no runs', () => {
    expect(groupRuns([], 's1')).toEqual([])
  })
})
