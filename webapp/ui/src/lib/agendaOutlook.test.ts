import { describe, expect, it } from 'vitest'

import { outlookCacheKey, outlookScopeLabel, outlookWindowLabel } from './agendaOutlook'

describe('outlookScopeLabel', () => {
  it('capitalises each scope', () => {
    expect(outlookScopeLabel('day')).toBe('Day')
    expect(outlookScopeLabel('week')).toBe('Week')
    expect(outlookScopeLabel('month')).toBe('Month')
  })
})

describe('outlookWindowLabel', () => {
  it('shows the date for day scope', () => {
    expect(outlookWindowLabel('day', '2026-08-13')).toBe('13 Aug')
  })

  it('shows the week label anchored from Monday', () => {
    expect(outlookWindowLabel('week', '2026-08-13')).toBe('Week of 10 Aug')
  })

  it('shows the month label', () => {
    expect(outlookWindowLabel('month', '2026-08-13')).toBe('Aug 2026')
  })
})

describe('outlookCacheKey', () => {
  it('combines scope and anchor', () => {
    expect(outlookCacheKey('week', '2026-08-13')).toBe('week:2026-08-13')
  })
})
