import { describe, expect, it } from 'vitest'
import { allNavSections, navItemFor, sectionForPath } from './NavItems'

/**
 * The sidebar is the roadmap, so its shape is a claim about the product and
 * worth pinning. Pure data and one pure function -- no DOM, in keeping with the
 * rest of this suite.
 */

const items = allNavSections.flatMap((section) => section.items)

describe('nav shape', () => {
  it('is the five Aion Platform sections, in order', () => {
    expect(allNavSections.map((s) => s.heading)).toEqual([
      'Home', 'Knowledge', 'Book', 'Markets & Macro', 'Strategy Lab',
    ])
  })

  it('carries all twenty destinations', () => {
    expect(items).toHaveLength(20)
  })

  it('gives every destination a distinct key and route', () => {
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length)
    expect(new Set(items.map((i) => i.route)).size).toBe(items.length)
  })

  it('explains every destination that is not built yet', () => {
    // A dimmed "Soon" row that says nothing on arrival is just a dead end. The
    // blurb is the spec, so an unbuilt item without one is a bug.
    const soon = items.filter((i) => !i.built)
    expect(soon.map((i) => i.key)).toEqual([
      'explorer',
      'investors',
    ])
    for (const item of soon) {
      expect(item.blurb, `${item.key} has no blurb`).toBeTruthy()
    }
  })

  it('keeps the pages absorbed from the old Engine section built', () => {
    expect(navItemFor('tl-mlstudio')?.built).toBe(true)
    expect(navItemFor('tl-databank')?.built).toBe(true)
  })

  /**
   * Indicators is the one place this sidebar deliberately differs from the
   * platform's. Moving an item between sections changes neither the heading
   * list nor the count, so both assertions above pass either way -- which is
   * exactly why the move needs pinning here, in the direction it was made.
   */
  it('files Indicators with the Strategy Lab, beside the Databank', () => {
    const section = (heading: string) =>
      allNavSections.find((s) => s.heading === heading)!.items.map((i) => i.key)

    expect(section('Strategy Lab')).toEqual([
      'tl-builder', 'tl-mlstudio', 'tl-databank', 'tl-alphazoo', 'indicators', 'tl-shadow', 'tl-roster',
    ])
    expect(navItemFor('tl-shadow')?.built).toBe(true)
    expect(section('Book')).not.toContain('indicators')
  })
})

describe('sectionForPath', () => {
  it('matches a destination and its children', () => {
    expect(sectionForPath('/markets')).toBe('markets')
    expect(sectionForPath('/book')).toBe('book')
    expect(sectionForPath('/book/abc123')).toBe('book')
  })

  it('keeps the dashboard highlighted while a conversation is open on it', () => {
    // Conversations live at /dashboard/:threadId; /chats is history only.
    expect(sectionForPath('/dashboard/some-thread-id')).toBe('dashboard')
    expect(sectionForPath('/chats')).toBe('chat')
    expect(sectionForPath('/chats/quick')).toBe('chat')
  })

  it('prefers the longer route, so /lab/builder never loses to a /lab prefix', () => {
    expect(sectionForPath('/lab/builder')).toBe('tl-builder')
    expect(sectionForPath('/lab/databank')).toBe('tl-databank')
  })

  it('hands routes with no nav entry to the item that owns them', () => {
    // Backtests are reached from the builder that started them. Without this
    // the run pages highlight Dashboard, which fails silently in the UI.
    expect(sectionForPath('/runs')).toBe('tl-builder')
    expect(sectionForPath('/runs/20240101_abc')).toBe('tl-builder')
  })

  it('keeps the redirected legacy routes highlighting their new home', () => {
    expect(sectionForPath('/models')).toBe('tl-mlstudio')
    expect(sectionForPath('/factors')).toBe('tl-databank')
    expect(sectionForPath('/data')).toBe('markets')
  })

  it('falls back to the dashboard for anything unknown', () => {
    expect(sectionForPath('/nope')).toBe('dashboard')
  })
})
