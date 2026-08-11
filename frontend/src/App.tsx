import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import { ThemeProvider } from './hooks/useTheme'
import { MobileNavProvider } from './components/layout/MobileNavContext'
import { AuthForm } from './components/auth/AuthForm'
import { ChatPage } from './pages/ChatPage'
import { DocumentsPage } from './pages/DocumentsPage'
import { SkillsPage } from './pages/SkillsPage'

function AppContent() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <MobileNavProvider>
      <Routes>
        <Route
          path="/"
          element={<Navigate to="/chat" replace />}
        />
        <Route
          path="/chat/:threadId?"
          element={user ? <ChatPage /> : <Navigate to="/auth" replace />}
        />
        <Route
          path="/documents/:folderId?"
          element={user ? <DocumentsPage /> : <Navigate to="/auth" replace />}
        />
        <Route
          path="/skills/:skillId?"
          element={user ? <SkillsPage /> : <Navigate to="/auth" replace />}
        />
        <Route
          path="/auth"
          element={user ? <Navigate to="/chat" replace /> : <AuthForm />}
        />
        <Route
          path="*"
          element={<Navigate to="/chat" replace />}
        />
      </Routes>
      </MobileNavProvider>
    </BrowserRouter>
  )
}

function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  )
}

export default App
