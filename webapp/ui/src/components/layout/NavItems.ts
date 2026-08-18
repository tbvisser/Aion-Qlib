import {
  Plus, MessageSquare, FolderKanban, Shapes, Clock, CalendarDays,
  Folder, Network, Library,
  Briefcase, Users, Wallet,
  CandlestickChart, Landmark,
  SlidersHorizontal, Brain, Boxes, Copy, Bot,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Copied from the Aion Platform's layout/NavItems.ts — same headings, labels,
// icons and routes, in the same order, so the two sidebars are the same object.
//
// **First divergence: three destinations folded into the Database.**
// Indicators, the Alpha Zoo and the old Databank all answered one question —
// "what can I put in a factor?" — from three pages, over three unrelated
// sources, with no way to search them together. They are now sub-tabs of one
// Database backed by a single index, and their rows are gone from this list.
// Nothing was lost in the fold: the zoo's 462 alphas are the `vibe` source in
// Alphas, Indicators keeps its per-store dead-column marks and its banner, and
// the Databank's evaluator is the detail rail beside the alpha it measures.
// Every folded route still resolves and highlights the Database row — see
// ROUTE_OWNERS below and `tabForLegacyRoute` in lib/catalog.ts. Do not
// "restore" these to match the platform without folding them there too.
//
// Vibe Agent folded into Agents & Skills for the same reason and by the same
// mechanism: it is one of several agent consoles, not a destination.
//
// **Second divergence: the Home group is the assistant shell, not a page list.**
// Its six rows are New / Chats and tasks / Projects / Artifacts / Scheduled /
// Agenda — the shape of an assistant's home rather than a menu of Aion's
// surfaces. `dashboard` keeps its key and its `/dashboard` route and now backs
// the "New" row, because the dashboard *is* the new-conversation surface; a
// separate "Dashboard" row beside it was two names for one page.
//
// Vibe Agent moved out of Home and down to the Strategy Lab, and has since
// folded into Agents & Skills entirely — see the first divergence above.
//
// The sidebar is the roadmap. Every destination renders, built or not; the ones
// that aren't built are dimmed and chipped "Soon" and say on arrival what they
// will do and which existing piece folds into them. Hiding them made the app
// look finished and the plan invisible.
export type SectionKey =
  | 'dashboard' | 'chat' | 'projects' | 'artifacts' | 'scheduled' | 'inbox'
  | 'code'
  | 'documents' | 'explorer' | 'corpus'
  | 'book' | 'accounts' | 'investors'
  | 'markets' | 'macro'
  | 'tl-builder' | 'tl-mlstudio' | 'tl-database' | 'tl-shadow' | 'tl-roster'

export interface NavItem {
  key: SectionKey
  label: string
  icon: LucideIcon
  route: string
  /** False when the route only renders a ComingSoon placeholder. */
  built?: boolean
  /**
   * What this destination becomes, and which existing piece folds into it.
   * PlaceholderPage renders it, so the spec for an unbuilt page lives next to
   * its nav entry and the two can't drift apart. Built items don't need one.
   */
  blurb?: string
}

export interface NavSection {
  heading: string
  items: NavItem[]
}

export const mainNavSections: NavSection[] = [
  {
    heading: 'Home',
    items: [
      // "New" is the dashboard: the composer you land on with nothing open.
      { key: 'dashboard', label: 'New', icon: Plus, route: '/dashboard', built: true },
      { key: 'chat', label: 'Chats and tasks', icon: MessageSquare, route: '/chats', built: true },
      { key: 'projects', label: 'Projects', icon: FolderKanban, route: '/projects', built: true },
      { key: 'artifacts', label: 'Artifacts', icon: Shapes, route: '/artifacts', built: true },
      { key: 'scheduled', label: 'Scheduled', icon: Clock, route: '/scheduled', built: true },
      { key: 'inbox', label: 'Agenda', icon: CalendarDays, route: '/inbox', built: true },
    ],
  },
  {
    heading: 'Knowledge',
    items: [
      { key: 'documents', label: 'Documents', icon: Folder, route: '/documents', built: true },
      {
        key: 'explorer', label: 'Graph', icon: Network, route: '/explorer',
        blurb:
          'Entities and the links between them — instruments, factors, strategies, macro series. ' +
          'Generalises the Macro Desk linkage panel, which already computes drivers, betas, regime ' +
          'behaviour and event studies for one subject at a time.',
      },
      { key: 'corpus', label: 'Corpus', icon: Library, route: '/corpus', built: true },
    ],
  },
  {
    heading: 'Book',
    items: [
      { key: 'book', label: 'Portfolios & Strategies', icon: Briefcase, route: '/book', built: true },
      // Read-only broker views + paper trading through the Vibe-Trading
      // sidecar's trading_* tools. Live order placement is not reachable from
      // this app — the proxy's allowlist (webapp/api/routers/vibe.py) stops at
      // read + paper, and vibe's own mandate gates sit behind that.
      { key: 'accounts', label: 'Broker Accounts', icon: Wallet, route: '/accounts', built: true },
      // Journal-driven mimicry via the Vibe-Trading sidecar: upload a broker
      // trade export, mine it into if-then rules, backtest and forward-scan
      // them. (The original vision — forward-tracking a backtested strategy —
      // needs per-trade data our runs don't produce; the journal route is what
      // the sidecar's engine actually supports.)
      { key: 'tl-shadow', label: 'Shadow Accounts', icon: Copy, route: '/lab/shadow-accounts', built: true },
      {
        key: 'investors', label: 'Investors', icon: Users, route: '/investors',
        blurb:
          'Accounts and their allocations across portfolios, with statements. Builds on the portfolio ' +
          'records and NAV series that Portfolios & Strategies already serves.',
      },
    ],
  },
  {
    heading: 'Markets & Macro',
    items: [
      { key: 'markets', label: 'Markets', icon: CandlestickChart, route: '/markets', built: true },
      { key: 'macro', label: 'Macro Desk', icon: Landmark, route: '/macro', built: true },
    ],
  },
  {
    heading: 'Strategy Lab',
    items: [
      { key: 'tl-builder', label: 'Strategy Builder', icon: SlidersHorizontal, route: '/lab/keycards/new', built: true },
      { key: 'tl-mlstudio', label: 'ML Studio', icon: Brain, route: '/lab/ml-studio', built: true },
      // The Databank grew into the Database: one destination with a sub-tab per
      // collection, over a searchable index of every source at once. Three rows
      // folded into it and are gone from this list — Alpha Zoo (the sidecar's
      // 462 cross-sectional factors, now the `vibe` source in Alphas),
      // Indicators (Alpha158's 184, now its own sub-tab with the same
      // per-store dead-column marks), and the old Databank evaluator (now the
      // detail rail beside the alpha it measures). Their routes still resolve
      // and land on the sub-tab that took the work over; see ROUTE_OWNERS and
      // `tabForLegacyRoute`.
      { key: 'tl-database', label: 'Database', icon: Boxes, route: '/lab/database', built: true },
      // Vibe Agent folded in here rather than into the Database: it is an agent
      // console, not a collection. `/vibe-agent` still resolves and highlights
      // this row, and the roster surfaces it — the sidecar's API forbids
      // framing (CSP frame-ancestors 'none'), so it stays a status + launch
      // card opening same-origin on the sidecar itself (:8899), where its
      // SSE-ticket auth works unchanged.
      { key: 'tl-roster', label: 'Agents & Skills', icon: Bot, route: '/lab/roster', built: true },
    ],
  },
]

/**
 * The Code shell's nav: the short list a coding session actually uses.
 *
 * `code` is its own key rather than reusing `dashboard`, because Code's "New"
 * starts a session at `/code` while Home's starts a conversation at
 * `/dashboard`. Same word, different act.
 *
 * This list is short on purpose, and everything it leaves out stays one click
 * away behind the sidebar's "More" disclosure — see `mainNavSections`. Nothing
 * here is a destination Home does not also carry, apart from `/code` itself.
 */
export const codeNavSections: NavSection[] = [
  {
    heading: 'Code',
    items: [
      { key: 'code', label: 'New', icon: Plus, route: '/code', built: true },
      { key: 'artifacts', label: 'Artifacts', icon: Shapes, route: '/artifacts', built: true },
      { key: 'inbox', label: 'Agenda', icon: CalendarDays, route: '/inbox', built: true },
    ],
  },
]

/** What "More" opens in the Code shell: the platform, minus its own Home group. */
export const moreNavSections: NavSection[] = mainNavSections.filter(
  (section) => section.heading !== 'Home',
)

/**
 * Every destination the Home shell lists. Routing, active-state highlighting
 * and both sidebars use this — there is no built-only variant, because
 * filtering one in is what made nine destinations invisible.
 */
export const allNavSections: NavSection[] = mainNavSections

/**
 * Routes with no nav entry of their own, and the item that owns them.
 * Consulted before the nav scan below, so a page reached from inside another
 * page still highlights the row it belongs to.
 */
const ROUTE_OWNERS: Array<[string, SectionKey]> = [
  ['/runs', 'tl-builder'],      // backtests belong to the builder that started them
  ['/lab/keycards', 'tl-builder'], // new workflow builder
  ['/lab/builder', 'tl-builder'],  // legacy builder, still reachable
  ['/models', 'tl-mlstudio'],   // legacy, redirected
  ['/data', 'markets'],         // legacy, redirected
  // Folded into the Database. Each still resolves — App.tsx redirects it to the
  // sub-tab that took its content — and each highlights the row it now lives
  // in, so a bookmark does not land on a page with nothing selected.
  ['/lab/databank', 'tl-database'],
  ['/lab/alpha-zoo', 'tl-database'],
  ['/indicators', 'tl-database'],
  ['/factors', 'tl-database'],
  // Folded into Agents & Skills.
  ['/vibe-agent', 'tl-roster'],
]

/**
 * Both shells' items, deduped by key — the Code nav re-lists Artifacts and
 * the Agenda, and `/code` appears in no other layout. This is what resolves a
 * pathname, so a destination reachable from either shell resolves from both.
 */
const allItems: NavItem[] = [
  ...allNavSections.flatMap((section) => section.items),
  ...codeNavSections
    .flatMap((section) => section.items)
    .filter(
      (item) =>
        !allNavSections.some((section) => section.items.some((seen) => seen.key === item.key)),
    ),
]

const owns = (route: string, pathname: string) =>
  pathname === route || pathname.startsWith(`${route}/`)

/** The nav key owning a pathname, for active-state highlighting. */
export function sectionForPath(pathname: string): SectionKey {
  const owner = ROUTE_OWNERS.find(([route]) => owns(route, pathname))
  if (owner) return owner[1]

  // Longest route first, so /lab/builder wins over a hypothetical /lab.
  const match = [...allItems]
    .sort((a, b) => b.route.length - a.route.length)
    .find((item) => owns(item.route, pathname))
  return match?.key ?? 'dashboard'
}

export function navItemFor(key: SectionKey): NavItem | undefined {
  return allItems.find((item) => item.key === key)
}
