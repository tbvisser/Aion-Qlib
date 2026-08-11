import { useState, useEffect } from 'react'
import { User, Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

const API_URL = import.meta.env.VITE_API_URL
const ADMIN_STATUS_TIMEOUT_MS = 3000

// useAuth() is consumed by ~15 components, each with its own getSession() +
// onAuthStateChange subscription. Without sharing, every component mount and
// every auth event probes /auth/me — which floods the backend during the
// realtime-driven re-renders of a bulk upload (context menus and list rows
// remount constantly). Cache the result per access token, and collapse
// concurrent probes for the same token into a single in-flight request, so the
// backend sees one /auth/me per token instead of one per mount/event.
let adminStatusCache: { token: string; isAdmin: boolean } | null = null
let adminStatusInFlight: { token: string; promise: Promise<boolean> } | null = null

async function resolveAdminStatus(accessToken: string): Promise<boolean> {
  if (adminStatusCache?.token === accessToken) return adminStatusCache.isAdmin
  if (adminStatusInFlight?.token === accessToken) return adminStatusInFlight.promise

  const promise = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ADMIN_STATUS_TIMEOUT_MS)

    try {
      const response = await fetch(`${API_URL}/auth/me`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
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

export function useAuth() {
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

    // Get initial session
    supabase.auth.getSession()
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

    // Listen for auth changes
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
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (error) throw error
  }

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
    })
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

  return {
    user,
    session,
    loading,
    isAdmin,
    signIn,
    signUp,
    signOut,
  }
}
