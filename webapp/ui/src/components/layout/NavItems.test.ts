import { describe, expect, it } from 'vitest'
import {
  allNavSections,
  codeNavSections,
  moreNavSections,
  navItemFor,
  sectionForPath,
} from './NavItems'

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
    // Three fewer than the platform's twenty-three. Alpha Zoo and Indicators
    // folded into the Databank -- which became the Database, a rename rather
    // than a removal, so it still holds a row -- and Vibe Agent folded into
    // Agents & Skills.
    expect(items).toHaveLength(20)
  })

  /**
   * Home is the assistant shell, not a list of Aion's surfaces: New, then the
   * four things the assistant produces, then the agenda. `dashboard` backs
   * "New" because the dashboard is the new-conversation surface — the two rows
   * this replaced were one page under two names.
   */
  it('shapes Home as the assistant shell, New first and the Agenda last', () => {
    const home = allNavSections.find((s) => s.heading === 'Home')!
    expect(home.items.map((i) => i.key)).toEqual([
      'dashboard', 'chat', 'projects', 'artifacts', 'scheduled', 'inbox',
    ])
    expect(navItemFor('dashboard')?.label).toBe('New')
    expect(navItemFor('dashboard')?.route).toBe('/dashboard')
    // The key and route keep their old name — the sidebar's unread badge and
    // every existing link point at them — but the row reads "Agenda".
    expect(navItemFor('inbox')?.label).toBe('Agenda')
    expect(navItemFor('inbox')?.route).toBe('/inbox')
  })

  it('has no row of its own for anything folded into another destination', () => {
    // The fold is only real if the row is gone. Each of these still resolves as
    // a route -- App.tsx redirects it -- but a sidebar row beside the
    // destination that absorbed it would be two doors to one room.
    for (const key of ['tl-alphazoo', 'indicators', 'tl-databank', 'vibe-agent']) {
      expect(items.map((i) => i.key), `${key} still has a nav row`).not.toContain(key)
    }
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
    expect(navItemFor('tl-database')?.built).toBe(true)
  })

  /**
   * The Strategy Lab is where the fold is visible: eight rows became four. This
   * is pinned as an exact list rather than a membership check because a
   * regression here looks like a restoration -- someone "putting Indicators
   * back" would pass every other assertion in this file.
   */
  it('shapes the Strategy Lab as five rows around the Database and Markov Chains', () => {
    const section = (heading: string) =>
      allNavSections.find((s) => s.heading === heading)!.items.map((i) => i.key)

    expect(section('Strategy Lab')).toEqual([
      'tl-builder', 'tl-mlstudio', 'tl-database', 'tl-markov', 'tl-roster',
    ])
    expect(navItemFor('tl-database')?.route).toBe('/lab/database')
    expect(navItemFor('tl-markov')?.route).toBe('/lab/markov')
  })

  it('sits Shadow Accounts in the Book, under Broker Accounts', () => {
    const book = allNavSections.find((s) => s.heading === 'Book')!
    expect(book.items.map((i) => i.key)).toEqual([
      'book', 'accounts', 'tl-shadow', 'investors',
    ])
    expect(navItemFor('tl-shadow')?.built).toBe(true)
  })
})

describe('the Code shell', () => {
  it('lists only what a coding session uses', () => {
    expect(codeNavSections.flatMap((s) => s.items).map((i) => i.key)).toEqual([
      'code', 'artifacts', 'inbox',
    ])
  })

  /**
   * `code` is its own key rather than a second use of `dashboard`: Code's "New"
   * starts a session at /code, Home's starts a conversation at /dashboard. Same
   * word, different act — and one key cannot highlight two rows.
   */
  it('gives Code its own New, distinct from the dashboard', () => {
    expect(navItemFor('code')?.route).toBe('/code')
    expect(navItemFor('dashboard')?.route).toBe('/dashboard')
  })

  it('strands nothing — More carries the rest of the platform', () => {
    // Everything Home lists is either in the Code nav or behind More. A
    // destination in neither would be unreachable from the Code shell.
    const reachable = new Set([
      ...codeNavSections.flatMap((s) => s.items.map((i) => i.key)),
      ...moreNavSections.flatMap((s) => s.items.map((i) => i.key)),
    ])
    const home = allNavSections.find((s) => s.heading === 'Home')!
    const stranded = allNavSections
      .flatMap((s) => s.items)
      .filter((i) => !reachable.has(i.key))
      .filter((i) => !home.items.some((h) => h.key === i.key))
    expect(stranded.map((i) => i.key)).toEqual([])
  })

  it('keeps More free of the Home group it replaces', () => {
    expect(moreNavSections.map((s) => s.heading)).toEqual([
      'Knowledge', 'Book', 'Markets & Macro', 'Strategy Lab',
    ])
  })
})

describe('sectionForPath', () => {
  it('matches a destination and its children', () => {
    expect(sectionForPath('/markets')).toBe('markets')
    expect(sectionForPath('/book')).toBe('book')
    expect(sectionForPath('/book/abc123')).toBe('book')
  })

  it('resolves the three new Home destinations', () => {
    expect(sectionForPath('/projects')).toBe('projects')
    expect(sectionForPath('/projects/abc123')).toBe('projects')
    expect(sectionForPath('/artifacts')).toBe('artifacts')
    expect(sectionForPath('/scheduled')).toBe('scheduled')
  })

  it('resolves /code, which only the Code shell lists', () => {
    // The two shells are separate *layouts*; resolution spans both, or landing
    // on /code would highlight the dashboard.
    expect(sectionForPath('/code')).toBe('code')
  })

  it('keeps the dashboard highlighted while a conversation is open on it', () => {
    // Conversations live at /dashboard/:threadId; /chats is history only.
    expect(sectionForPath('/dashboard/some-thread-id')).toBe('dashboard')
    expect(sectionForPath('/chats')).toBe('chat')
    expect(sectionForPath('/chats/quick')).toBe('chat')
  })

  it('prefers the longer route, so /lab/builder never loses to a /lab prefix', () => {
    expect(sectionForPath('/lab/builder')).toBe('tl-builder')
    expect(sectionForPath('/lab/database')).toBe('tl-database')
  })

  it('hands routes with no nav entry to the item that owns them', () => {
    // Backtests are reached from the builder that started them. Without this
    // the run pages highlight Dashboard, which fails silently in the UI.
    expect(sectionForPath('/runs')).toBe('tl-builder')
    expect(sectionForPath('/runs/20240101_abc')).toBe('tl-builder')
  })

  it('keeps the redirected legacy routes highlighting their new home', () => {
    expect(sectionForPath('/models')).toBe('tl-mlstudio')
    expect(sectionForPath('/data')).toBe('markets')
  })

  it('highlights the destination that absorbed each folded route', () => {
    // A bookmark to a folded page redirects; without these it would land on the
    // right page with the wrong row lit, which fails silently in the UI.
    expect(sectionForPath('/lab/databank')).toBe('tl-database')
    expect(sectionForPath('/lab/alpha-zoo')).toBe('tl-database')
    expect(sectionForPath('/indicators')).toBe('tl-database')
    expect(sectionForPath('/factors')).toBe('tl-database')
    expect(sectionForPath('/vibe-agent')).toBe('tl-roster')
  })

  it('falls back to the dashboard for anything unknown', () => {
    expect(sectionForPath('/nope')).toBe('dashboard')
  })
})
