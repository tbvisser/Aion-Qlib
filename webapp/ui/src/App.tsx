import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppSidebar } from '@/components/layout/AppSidebar'
import { allNavSections, sectionForPath } from '@/components/layout/NavItems'
import { useAuth } from '@/hooks/useAuth'
import { LoginPage } from '@/components/auth/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { MarketsPage } from '@/pages/MarketsPage'
import { DatabankPage } from '@/pages/DatabankPage'
import { IndicatorsPage } from '@/pages/IndicatorsPage'
import { StrategyBuilderPage } from '@/pages/StrategyBuilderPage'
import { RunsPage } from '@/pages/RunsPage'
import { MLStudioPage } from '@/pages/MLStudioPage'
import { ChatPage } from '@/pages/ChatPage'
import { MacroDeskPage } from '@/pages/MacroDeskPage'
import { PortfoliosPage } from '@/pages/PortfoliosPage'
import { PlaceholderPage } from '@/pages/PlaceholderPage'

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
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <AppSidebar activeSection={sectionForPath(pathname)} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/chats" element={<ChatPage />} />
          <Route path="/lab/builder" element={<StrategyBuilderPage />} />
          <Route path="/lab/ml-studio" element={<MLStudioPage />} />
          <Route path="/lab/databank" element={<DatabankPage />} />
          <Route path="/markets" element={<MarketsPage />} />
          <Route path="/macro" element={<MacroDeskPage />} />
          <Route path="/book" element={<PortfoliosPage />} />
          <Route path="/book/:portfolioId" element={<PortfoliosPage />} />
          {/* Pages that moved into a platform destination. Old links, bookmarks
              and anything already sent out keep working. Data Explorer became
              Markets; Factor Lab became the Databank; Models became ML Studio. */}
          <Route path="/data" element={<Navigate to="/markets" replace />} />
          <Route path="/factors" element={<Navigate to="/lab/databank" replace />} />
          <Route path="/models" element={<Navigate to="/lab/ml-studio" replace />} />
          <Route path="/indicators" element={<IndicatorsPage />} />
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
  )
}
