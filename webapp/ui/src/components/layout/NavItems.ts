import {
  LayoutDashboard, MessageSquare, Shapes, CalendarDays,
  Folder, Network, Library,
  Briefcase, Users, LineChart, Wallet,
  CandlestickChart, Landmark,
  SlidersHorizontal, Brain, Boxes, Copy, Bot, FlaskConical, Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Copied from the Aion Platform's layout/NavItems.ts — same headings, labels,
// icons and routes, in the same order, so the two sidebars are the same object.
//
// **One deliberate divergence: Indicators sits under Strategy Lab, not Book.**
// It is the expression vocabulary a strategy is built out of — raw material,
// the same kind of thing as the Databank it now sits beside — and having it
// three sections away from the builder that consumes it meant the one page
// answering "what can I put in a factor?" was filed with portfolios and
// investors. The key and the `/indicators` route are unchanged, so every
// existing link, redirect and highlight rule still resolves. Do not "restore"
// this to match the platform without moving it there too.
//
// The sidebar is the roadmap. Every destination renders, built or not; the ones
// that aren't built are dimmed and chipped "Soon" and say on arrival what they
// will do and which existing piece folds into them. Hiding them made the app
// look finished and the plan invisible.
export type SectionKey =
  | 'dashboard' | 'chat' | 'artifacts' | 'inbox' | 'vibe-agent'
  | 'documents' | 'explorer' | 'corpus'
  | 'book' | 'accounts' | 'investors' | 'indicators'
  | 'markets' | 'macro'
  | 'tl-builder' | 'tl-mlstudio' | 'tl-databank' | 'tl-alphazoo' | 'tl-shadow' | 'tl-roster'

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
      { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, route: '/dashboard', built: true },
      { key: 'chat', label: 'Chats', icon: MessageSquare, route: '/chats', built: true },
      { key: 'artifacts', label: 'Artifacts', icon: Shapes, route: '/artifacts', built: true },
      { key: 'inbox', label: 'Agenda', icon: CalendarDays, route: '/inbox', built: true },
      // The Vibe-Trading sidecar's own agent/swarm console. Its API forbids
      // framing (CSP frame-ancestors 'none'), so this destination is a status
      // + launch page, not an embed — the console opens same-origin on the
      // sidecar itself (:8899), where its SSE-ticket auth works unchanged.
      { key: 'vibe-agent', label: 'Vibe Agent', icon: Sparkles, route: '/vibe-agent', built: true },
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
      { key: 'tl-builder', label: 'Strategy Builder', icon: SlidersHorizontal, route: '/lab/builder', built: true },
      { key: 'tl-mlstudio', label: 'ML Studio', icon: Brain, route: '/lab/ml-studio', built: true },
      { key: 'tl-databank', label: 'Databank', icon: Boxes, route: '/lab/databank', built: true },
      // Vibe-Trading's 462-alpha registry, browsed via the vibe sidecar
      // (webapp/api/routers/vibe.py). Sits beside the Databank because both
      // answer "what factors exist?" — Databank for qlib expressions, the Zoo
      // for the sidecar's cross-sectional academic/fundamental catalog.
      { key: 'tl-alphazoo', label: 'Alpha Zoo', icon: FlaskConical, route: '/lab/alpha-zoo', built: true },
      // Moved here from Book — see the divergence note at the top of the file.
      { key: 'indicators', label: 'Indicators', icon: LineChart, route: '/indicators', built: true },
      // Journal-driven mimicry via the Vibe-Trading sidecar: upload a broker
      // trade export, mine it into if-then rules, backtest and forward-scan
      // them. (The original vision — forward-tracking a backtested strategy —
      // needs per-trade data our runs don't produce; the journal route is what
      // the sidecar's engine actually supports.)
      { key: 'tl-shadow', label: 'Shadow Accounts', icon: Copy, route: '/lab/shadow-accounts', built: true },
      { key: 'tl-roster', label: 'Agents & Skills', icon: Bot, route: '/lab/roster', built: true },
    ],
  },
]

/**
 * Every destination. Routing, active-state highlighting and both sidebars all
 * use this — there is no built-only variant, because filtering one in is what
 * made nine destinations invisible.
 */
export const allNavSections: NavSection[] = mainNavSections

/**
 * Routes with no nav entry of their own, and the item that owns them.
 * Consulted before the nav scan below, so a page reached from inside another
 * page still highlights the row it belongs to.
 */
const ROUTE_OWNERS: Array<[string, SectionKey]> = [
  ['/runs', 'tl-builder'],      // backtests belong to the builder that started them
  ['/models', 'tl-mlstudio'],   // legacy, redirected
  ['/factors', 'tl-databank'],  // legacy, redirected
  ['/data', 'markets'],         // legacy, redirected
]

const allItems = allNavSections.flatMap((section) => section.items)

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
