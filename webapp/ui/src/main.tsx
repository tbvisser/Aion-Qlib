import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from '@/hooks/useTheme'
import { AuthProvider } from '@/hooks/useAuth'
import { OrgProvider } from '@/hooks/useOrg'
import { ErrorBoundary } from '@/components/layout/ErrorBoundary'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          {/* Inside AuthProvider: the org list is fetched with the session's
              token, so it cannot load before there is one. */}
          <OrgProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </OrgProvider>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
