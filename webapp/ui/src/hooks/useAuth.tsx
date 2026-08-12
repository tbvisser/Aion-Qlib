import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { RAG_API_URL } from '@/features/rag/lib/base'

const ADMIN_STATUS_TIMEOUT_MS = 3000

// The admin probe is cached per access token, with concurrent probes for the
// same token collapsed into one in-flight request. Ported from Aion-RAG's
// useAuth, where ~15 independent hook instances each re-probed /auth/me on
// every mount; here a single provider owns the session, but the cache still
// spares the backend a probe on every token refresh re-render.
let adminStatusCache: { token: string; isAdmin: boolean } | null = null
let adminStatusInFlight: { token: string; promise: Promise<boolean> } | null = null

async function resolveAdminStatus(accessToken: string): Promise<boolean> {
  if (adminStatusCache?.token === accessToken) return adminStatusCache.isAdmin
  if (adminStatusInFlight?.token === accessToken) return adminStatusInFlight.promise

  const promise = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ADMIN_STATUS_TIMEOUT_MS)

    try {
      const response = await fetch(`${RAG_API_URL}/auth/me`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: controller.signal,
      })
      const isAdmin = response.ok ? (await response.json()).is_admin === true : false
      adminStatusCache = { token: accessToken, isAdmin }
      return isAdmin
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
      if (adminStatusInFlight?.token === accessToken) adminStatusInFlight = null
    }
  })()

  adminStatusInFlight = { token: accessToken, promise }
  return promise
}

interface AuthContextValue {
  user: User | null
  session: Session | null
  loading: boolean
  isAdmin: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    let cancelled = false
    let latestAdminToken: string | null = null

    const applySession = (session: Session | null) => {
      const accessToken = session?.access_token ?? null
      latestAdminToken = accessToken

      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)

      if (!accessToken) {
        setIsAdmin(false)
        return
      }

      void resolveAdminStatus(accessToken).then((admin) => {
        if (!cancelled && latestAdminToken === accessToken) {
          setIsAdmin(admin)
        }
      })
    }

    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (!cancelled) applySession(session)
      })
      .catch(() => {
        if (!cancelled) {
          latestAdminToken = null
          setSession(null)
          setUser(null)
          setIsAdmin(false)
          setLoading(false)
        }
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) {
        applySession(session)
      }
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    // Drop the shared probe so the next user re-checks instead of inheriting
    // the previous session's admin status.
    adminStatusCache = null
    adminStatusInFlight = null
    setIsAdmin(false)
  }

  return (
    <AuthContext.Provider
      value={{ user, session, loading, isAdmin, signIn, signUp, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
