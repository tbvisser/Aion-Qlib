import { describe, expect, it } from 'vitest'

import type { AgendaEntry } from './agenda'
import {
  assignLanes, axisBucket, clusterByStart, timelineItems,
} from './agendaTimeline'

// Timezone-free local instants: parsed in the runner's zone either way, so
// the derived wall clock is stable wherever the tests run.
const local = (clock: string) => `2026-08-11T${clock}:00`

function entry(over: Partial<AgendaEntry>): AgendaEntry {
  return {
    key: 'k', date: '2026-08-11', time: null, timestamp: null,
    type: 'process', title: 'x',
    payload: { kind: 'note', note: 'stale' },
    ...over,
  }
}

describe('timelineItems', () => {
  it('release times parse verbatim; timestamps fall back to the local clock', () => {
    const { timed, allDay } = timelineItems([
      entry({ key: 'rel', type: 'release', time: '08:30:00' }),
      entry({ key: 'act', type: 'trade', timestamp: local('09:15') }),
    ])
    expect(allDay).toEqual([])
    expect(timed.map((t) => [t.entry.key, t.startMin])).toEqual([
      ['rel', 8 * 60 + 30],
      ['act', 9 * 60 + 15],
    ])
  })

  it('nothing is invented: no time and no timestamp means the all-day lane', () => {
    const { timed, allDay } = timelineItems([
      entry({ key: 'undated' }),
      entry({ key: 'broken', timestamp: 'not-a-date' }),
      entry({ key: 'weird-time', time: 'tentative' }),
    ])
    expect(timed).toEqual([])
    expect(allDay.map((e) => e.key)).toEqual(['undated', 'broken', 'weird-time'])
  })

  it('sorts by start minute, then key for determinism', () => {
    const { timed } = timelineItems([
      entry({ key: 'b', time: '10:00' }),
      entry({ key: 'a', time: '10:00' }),
      entry({ key: 'c', time: '07:00' }),
    ])
    expect(timed.map((t) => t.entry.key)).toEqual(['c', 'a', 'b'])
  })
})

describe('assignLanes', () => {
  it('items closer than the slot share no lane; lanes are reused when free', () => {
    const { timed } = timelineItems([
      entry({ key: 'a', time: '08:30' }),
      entry({ key: 'b', time: '08:40' }),
      entry({ key: 'c', time: '09:05' }),
    ])
    const lanes = assignLanes(timed, 30)
    expect(lanes.map((l) => [l.entry.key, l.lane])).toEqual([
      ['a', 0], ['b', 1], ['c', 0],
    ])
  })

  it('a quiet day is a single lane', () => {
    const { timed } = timelineItems([
      entry({ key: 'a', time: '08:30' }),
      entry({ key: 'b', time: '13:30' }),
    ])
    expect(assignLanes(timed).every((l) => l.lane === 0)).toBe(true)
  })
})

describe('clusterByStart', () => {
  it('a macro minute becomes one block that keeps every entry', () => {
    const { timed } = timelineItems([
      entry({ key: 'cpi', time: '12:30' }),
      entry({ key: 'ppi', time: '12:30' }),
      entry({ key: 'claims', time: '12:30' }),
      entry({ key: 'eia', time: '14:30' }),
    ])
    const clusters = clusterByStart(timed)
    expect(clusters.map((c) => [c.startMin, c.entries.length])).toEqual([
      [12 * 60 + 30, 3],
      [14 * 60 + 30, 1],
    ])
    expect(clusters[0].entries.map((e) => e.key)).toEqual(['claims', 'cpi', 'ppi'])
  })

  it('distinct minutes never merge, and the result is in time order', () => {
    const { timed } = timelineItems([
      entry({ key: 'late', time: '15:00' }),
      entry({ key: 'early', time: '08:00' }),
      entry({ key: 'mid', time: '08:01' }),
    ])
    expect(clusterByStart(timed).map((c) => c.startMin)).toEqual([
      8 * 60, 8 * 60 + 1, 15 * 60,
    ])
  })

  it('an empty day clusters to nothing', () => {
    expect(clusterByStart([])).toEqual([])
  })
})

describe('axisBucket', () => {
  it('collapses out-of-axis prints into gutters instead of stretching the axis', () => {
    expect(axisBucket(5 * 60)).toBe('early')
    expect(axisBucket(6 * 60)).toBe('axis')
    expect(axisBucket(21 * 60 + 59)).toBe('axis')
    expect(axisBucket(22 * 60)).toBe('late')
  })
})
