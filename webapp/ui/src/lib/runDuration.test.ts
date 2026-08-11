import { describe, expect, it } from 'vitest'

import type { Run, RunStatus } from './api'
import { formatDuration, medianDuration } from './runDuration'

/** A run that started at t=0 and lasted `seconds`. */
const run = (
  id: string, seconds: number | null, status: RunStatus = 'succeeded',
): Run => ({
  id,
  name: id,
  kind: 'backtest',
  status,
  phase: '',
  created_at: '2026-08-01T00:00:00Z',
  started_at: '2026-08-01T00:01:00Z',
  finished_at: seconds == null
    ? null
    : new Date(Date.parse('2026-08-01T00:01:00Z') + seconds * 1000).toISOString(),
  exit_code: 0,
  error: null,
  experiment_name: 'e',
})

describe('medianDuration', () => {
  it('has nothing to say without history', () => {
    // Not zero, and not a made-up default: the panel needs to distinguish
    // "about 4 minutes" from "we have never run one of these".
    expect(medianDuration([])).toBeNull()
  })

  it('takes the middle of an odd sample', () => {
    expect(medianDuration([run('a', 60), run('b', 300), run('c', 120)]))
      .toBe(120_000)
  })

  it('averages the two middles of an even sample', () => {
    expect(medianDuration([run('a', 60), run('b', 100), run('c', 200), run('d', 400)]))
      .toBe(150_000)
  })

  it('ignores runs that did not succeed', () => {
    // A failure dies in seconds. Counting them makes a sweep of eight look
    // like a coffee break.
    const sample = [
      run('ok', 600),
      run('boom', 2, 'failed'),
      run('stopped', 3, 'cancelled'),
      run('waiting', null, 'queued'),
    ]
    expect(medianDuration(sample)).toBe(600_000)
  })

  it('ignores a succeeded run with no finish time', () => {
    expect(medianDuration([run('ok', 600), run('half', null)])).toBe(600_000)
  })

  it('drops a negative span rather than reporting one', () => {
    const backwards = {
      ...run('weird', 60),
      finished_at: '2026-07-31T00:00:00Z',
    }
    expect(medianDuration([backwards])).toBeNull()
    expect(medianDuration([backwards, run('ok', 300)])).toBe(300_000)
  })

  it('measures from started_at, so queue time is not counted twice', () => {
    // One run at a time means `created_at` includes the wait for the previous
    // run. The sweep multiplies duration by the number of runs; folding the
    // queue into each duration would count that wait once per run.
    const queued: Run = {
      ...run('late', 60),
      created_at: '2026-08-01T00:00:00Z',
      started_at: '2026-08-01T00:30:00Z',
      finished_at: '2026-08-01T00:31:00Z',
    }
    expect(medianDuration([queued])).toBe(60_000)
  })
})

describe('formatDuration', () => {
  it('uses seconds below a minute and a half', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(89_000)).toBe('89s')
  })

  it('rounds to whole minutes above that', () => {
    expect(formatDuration(90_000)).toBe('2 min')
    expect(formatDuration(707_000)).toBe('12 min')
  })

  it('breaks into hours past sixty minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(5_400_000)).toBe('1h 30m')
  })

  it('never claims more precision than a median of a few samples has', () => {
    expect(formatDuration(707_000)).not.toMatch(/\d+m \d+s/)
  })
})
