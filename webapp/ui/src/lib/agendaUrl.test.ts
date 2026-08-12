import { describe, expect, it } from 'vitest'

import {
  agendaPatch, clampMonth, orDefault, readAgendaParams, resolveFilter, resolveView,
} from './agendaUrl'

const TODAY = '2026-08-12'

const read = (search: string) => readAgendaParams(new URLSearchParams(search), TODAY)

describe('resolveView', () => {
  it('accepts the three views and repairs everything else to month', () => {
    expect(resolveView('month')).toBe('month')
    expect(resolveView('week')).toBe('week')
    expect(resolveView('agenda')).toBe('agenda')
    expect(resolveView(null)).toBe('month')
    expect(resolveView('quarter')).toBe('month')
    expect(resolveView('')).toBe('month')
  })
})

describe('resolveFilter', () => {
  it('accepts the five types plus all, and repairs the rest', () => {
    expect(resolveFilter('release')).toBe('release')
    expect(resolveFilter('notification')).toBe('notification')
    expect(resolveFilter('all')).toBe('all')
    expect(resolveFilter(null)).toBe('all')
    expect(resolveFilter('runs')).toBe('all')
  })
})

describe('readAgendaParams', () => {
  it('falls back to today and the current month when nothing is set', () => {
    expect(read('')).toEqual({
      filter: 'all',
      view: 'month',
      monthCandidate: '2026-08',
      day: TODAY,
      entryKey: null,
      query: '',
    })
  })

  it('reads a fully specified URL', () => {
    expect(read('type=trade&view=week&month=2026-05&day=2026-05-04&entry=run:abc&q=cpi'))
      .toEqual({
        filter: 'trade',
        view: 'week',
        monthCandidate: '2026-05',
        day: '2026-05-04',
        entryKey: 'run:abc',
        query: 'cpi',
      })
  })

  it('repairs a malformed month to the current one', () => {
    expect(read('month=2026-8').monthCandidate).toBe('2026-08')
    expect(read('month=last-may').monthCandidate).toBe('2026-08')
    expect(read('month=2026-08-01').monthCandidate).toBe('2026-08')
  })

  it('repairs a malformed day to today', () => {
    expect(read('day=2026-08').day).toBe(TODAY)
    expect(read('day=yesterday').day).toBe(TODAY)
    expect(read('day=2026-8-1').day).toBe(TODAY)
  })

  it('does not clamp the month — that needs the calendar coverage', () => {
    expect(read('month=1999-01').monthCandidate).toBe('1999-01')
  })
})

describe('clampMonth', () => {
  const bounds = { minMonth: '2025-09', maxMonth: '2026-09' }

  it('leaves a month inside the bounds alone', () => {
    expect(clampMonth('2026-08', bounds)).toBe('2026-08')
    expect(clampMonth('2025-09', bounds)).toBe('2025-09')
    expect(clampMonth('2026-09', bounds)).toBe('2026-09')
  })

  it('pulls a month before the cache up to the floor', () => {
    expect(clampMonth('2019-04', bounds)).toBe('2025-09')
  })

  it('pulls a month past the horizon back to the ceiling', () => {
    expect(clampMonth('2030-01', bounds)).toBe('2026-09')
  })
})

describe('agendaPatch', () => {
  it('sets, replaces and deletes', () => {
    const from = new URLSearchParams('type=trade&view=week')
    const next = agendaPatch(from, { type: 'release', view: null, day: '2026-08-20' })
    expect(next.get('type')).toBe('release')
    expect(next.has('view')).toBe(false)
    expect(next.get('day')).toBe('2026-08-20')
  })

  it('treats the empty string as a delete, so a cleared search leaves no ?q=', () => {
    expect(agendaPatch(new URLSearchParams('q=cpi'), { q: '' }).has('q')).toBe(false)
  })

  it('does not mutate the params it was given', () => {
    const from = new URLSearchParams('type=trade')
    agendaPatch(from, { type: null })
    expect(from.get('type')).toBe('trade')
  })

  it('leaves params it was not asked about untouched', () => {
    const next = agendaPatch(new URLSearchParams('type=trade&q=cpi'), { view: 'agenda' })
    expect(next.get('type')).toBe('trade')
    expect(next.get('q')).toBe('cpi')
  })
})

describe('orDefault', () => {
  it('collapses the default to null so the URL stays clean', () => {
    expect(orDefault('month', 'month')).toBeNull()
    expect(orDefault('week', 'month')).toBe('week')
  })

  it('round-trips through agendaPatch as a delete', () => {
    const next = agendaPatch(new URLSearchParams('view=week'), {
      view: orDefault('month', 'month'),
    })
    expect(next.toString()).toBe('')
  })
})
