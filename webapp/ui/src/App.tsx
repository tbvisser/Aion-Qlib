import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { allNavSections, sectionForPath } from '@/components/layout/NavItems'
import { useAuth } from '@/hooks/useAuth'
import { InboxProvider } from '@/hooks/useInbox'
import { LoginPage } from '@/components/auth/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { MarketsPage } from '@/pages/MarketsPage'
import { DatabasePage } from '@/pages/DatabasePage'
import { ShadowAccountsPage } from '@/pages/ShadowAccountsPage'
import { StrategyBuilderPage } from '@/pages/StrategyBuilderPage'
import { KeycardBuilderPage } from '@/pages/KeycardBuilderPage'
import { RunsPage } from '@/pages/RunsPage'
import { MLStudioPage } from '@/pages/MLStudioPage'
import { ChatPage } from '@/pages/ChatPage'
import { MacroDeskPage } from '@/pages/MacroDeskPage'
import { MarkovChainPage } from '@/pages/MarkovChainPage'
import { PortfoliosPage } from '@/pages/PortfoliosPage'
import { PortfolioDetailPage } from '@/pages/PortfolioDetailPage'
import { StrategyDetailPage } from '@/pages/StrategyDetailPage'
import { AccountsPage } from '@/pages/AccountsPage'
import { AgendaPage } from '@/pages/AgendaPage'
import { CodePage } from '@/pages/CodePage'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { ArtifactsPage } from '@/pages/ArtifactsPage'
import { ScheduledPage } from '@/pages/ScheduledPage'
import { MembersPage } from '@/pages/MembersPage'
import { AcceptInvitePage } from '@/pages/AcceptInvitePage'
import { PlaceholderPage } from '@/pages/PlaceholderPage'
import { RosterPage } from '@/pages/RosterPage'
import { DocumentsPage } from '@/features/rag/pages/DocumentsPage'
import { CorpusPage } from '@/features/rag/pages/CorpusPage'
import { ChatsHistoryPage, ChatThreadRedirect } from '@/features/rag/pages/ChatsHistoryPage'

// Every nav destination that isn't built here still gets a route, so the
// sidebar can carry the platform's full navigation without dead links.
const placeholderRoutes = allNavSections
  .flatMap((section) => section.items)
  .filter((item) => !item.built)
  .map((item) => item.route)

export default function App() {
  const { pathname } = useLocation()
  const { user, loading } = useAuth()

  // Auth gate rendered around the shell rather than as an /auth route: deep
  // links survive login (the requested URL is untouched while the gate shows),
  // and there is no extra route to keep in sync with the nav test.
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="animate-subtle-pulse text-sm text-muted-foreground">Loading…</div>
      </div>
    )
  }
  if (!user) {
    return <LoginPage />
  }

  return (
    // InboxProvider wraps the sidebar too, not just <main> — the rail's
    // unread badge must keep counting while the user is on any page.
    <InboxProvider>
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <AppSidebar activeSection={sectionForPath(pathname)} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/dashboard/:threadId" element={<DashboardPage />} />
          {/* The route keeps its old name: existing links and the sidebar's
              unread badge both point at it. */}
          <Route path="/inbox" element={<AgendaPage />} />
          <Route path="/code" element={<CodePage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectsPage />} />
          <Route path="/artifacts" element={<ArtifactsPage />} />
          <Route path="/scheduled" element={<ScheduledPage />} />
          <Route path="/scheduled/:taskId" element={<ScheduledPage />} />
          {/* Workspace membership. Not in the nav — reached from the user menu
              and from an invite link, which is where people actually look. */}
          <Route path="/members" element={<MembersPage />} />
          <Route path="/invite/:token" element={<AcceptInvitePage />} />
          <Route path="/chats" element={<ChatsHistoryPage />} />
          <Route path="/chats/quick" element={<ChatPage />} />
          <Route path="/chats/:threadId" element={<ChatThreadRedirect />} />
          <Route path="/lab/builder" element={<StrategyBuilderPage />} />
          <Route path="/lab/keycards" element={<Navigate to="/lab/keycards/new" replace />} />
          <Route path="/lab/keycards/new" element={<KeycardBuilderPage />} />
          <Route path="/lab/keycards/:id" element={<KeycardBuilderPage />} />
          <Route path="/lab/ml-studio" element={<MLStudioPage />} />
          {/* The Databank grew into the Database: one destination with a
              sub-tab per collection, over a searchable index of every source.
              The sub-tab lives in `?tab=`, so each folded-in route below
              redirects to the tab that took over its job rather than 404-ing. */}
          <Route path="/lab/database" element={<DatabasePage />} />
          <Route path="/lab/markov" element={<MarkovChainPage />} />
          <Route path="/lab/databank" element={<Navigate to="/lab/database?tab=alphas" replace />} />
          <Route path="/lab/alpha-zoo" element={<Navigate to="/lab/database?tab=alphas&source=vibe" replace />} />
          <Route path="/lab/shadow-accounts" element={<ShadowAccountsPage />} />
          <Route path="/lab/roster" element={<RosterPage />} />
          <Route path="/lab/roster/:skillId" element={<RosterPage />} />
          {/* Folded into Agents & Skills: an agent console among several,
              not a destination of its own. */}
          <Route path="/vibe-agent" element={<Navigate to="/lab/roster?tab=agents" replace />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/:folderId" element={<DocumentsPage />} />
          <Route path="/corpus" element={<CorpusPage />} />
          <Route path="/corpus/:documentId" element={<CorpusPage />} />
          <Route path="/markets" element={<MarketsPage />} />
          <Route path="/macro" element={<MacroDeskPage />} />
          <Route path="/book" element={<PortfoliosPage />} />
          <Route path="/book/portfolios/:portfolioId" element={<PortfolioDetailPage />} />
          <Route path="/book/strategies/:strategyId" element={<StrategyDetailPage />} />
          <Route path="/book/:portfolioId" element={<LegacyPortfolioRedirect />} />
          <Route path="/strategies/:strategyId" element={<LegacyStrategyRedirect />} />
          <Route path="/accounts" element={<AccountsPage />} />
          {/* Pages that moved into a platform destination. Old links, bookmarks
              and anything already sent out keep working. Data Explorer became
              Markets; Factor Lab became the Databank and then the Database;
              Models became ML Studio; Indicators folded into the Database. */}
          <Route path="/data" element={<Navigate to="/markets" replace />} />
          <Route path="/factors" element={<Navigate to="/lab/database?tab=alphas" replace />} />
          <Route path="/models" element={<Navigate to="/lab/ml-studio" replace />} />
          <Route path="/indicators" element={<Navigate to="/lab/database?tab=indicators" replace />} />
          {/* Backtests have no nav entry of their own — they're reached from the
              builder that started them, and highlight it. See ROUTE_OWNERS. */}
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:runId" element={<RunsPage />} />
          {placeholderRoutes.map((route) => (
            <Route key={route} path={route} element={<PlaceholderPage />} />
          ))}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
    </InboxProvider>
  )
}

/** Old `/book/:id` deep links now live under `/book/portfolios/:id`. */
function LegacyPortfolioRedirect() {
  const { portfolioId } = useParams()
  return <Navigate to={`/book/portfolios/${portfolioId}`} replace />
}

/** Old `/strategies/:id` deep links now live under `/book/strategies/:id`. */
function LegacyStrategyRedirect() {
  const { strategyId } = useParams()
  return <Navigate to={`/book/strategies/${strategyId}`} replace />
}
