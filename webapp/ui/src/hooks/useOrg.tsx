/**
 * Which organisation you are working in.
 *
 * Ownership in this app is two-level: a strategy belongs to a person, and is
 * scoped to the organisation they were acting in. Everyone gets a personal
 * organisation at signup, so this is never empty — switching to a company one
 * is additive, and the personal one stays.
 *
 * The choice is held in localStorage and sent as `X-Aion-Org` on every request
 * (see `lib/authFetch.ts`), and mirrored to the account's `default_org_id` so a
 * different browser opens where you left off. The backend validates the header
 * against membership, so a stale or tampered value is a 403 rather than a way
 * into someone else's workspace.
 *
 * Mirrors `useAuth`'s shape deliberately — same context-plus-provider layout,
 * so the two read the same way at call sites.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { useAuth } from '@/hooks/useAuth'
import { api, type Me, type Organization } from '@/lib/api'
import { getCurrentOrgId, setCurrentOrgId } from '@/lib/authFetch'

interface OrgContextValue {
  me: Me | null
  organizations: Organization[]
  current: Organization | null
  /** Role in the *current* org — not a global flag. Gates admin-only controls. */
  isOrgAdmin: boolean
  loading: boolean
  error: string | null
  switchOrg: (orgId: string) => Promise<void>
  createOrg: (name: string) => Promise<Organization>
  refresh: () => Promise<void>
}

const OrgContext = createContext<OrgContextValue | null>(null)

export function OrgProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user) {
      setMe(null)
      setLoading(false)
      return
    }
    try {
      const next = await api.me()
      setMe(next)
      setError(null)
      // Reconcile the stored choice with reality. Someone removed from an org
      // between sessions would otherwise keep sending a header the backend now
      // rejects, and every page would 403 with no way back.
      const stored = getCurrentOrgId()
      if (!stored || !next.organizations.some((o) => o.id === stored)) {
        setCurrentOrgId(next.org_id)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your organisations')
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const switchOrg = useCallback(async (orgId: string) => {
    setCurrentOrgId(orgId)
    // Remember it for the next browser, then reload so every open page refetches
    // against the new scope. A partial switch — some panels on the old org,
    // some on the new — would be worse than a blink.
    try {
      await api.setDefaultOrg(orgId)
    } catch {
      /* the header already carries it; the default is a convenience */
    }
    window.location.reload()
  }, [])

  const createOrg = useCallback(async (name: string) => {
    const org = await api.createOrg(name)
    await load()
    return org
  }, [load])

  const value = useMemo<OrgContextValue>(() => {
    const currentId = getCurrentOrgId() ?? me?.org_id ?? null
    const current =
      me?.organizations.find((o) => o.id === currentId) ??
      me?.organizations.find((o) => o.id === me.org_id) ??
      null
    return {
      me,
      organizations: me?.organizations ?? [],
      current,
      isOrgAdmin: current ? current.role !== 'member' : false,
      loading,
      error,
      switchOrg,
      createOrg,
      refresh: load,
    }
  }, [me, loading, error, switchOrg, createOrg, load])

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
}

export function useOrg(): OrgContextValue {
  const context = useContext(OrgContext)
  if (!context) {
    throw new Error('useOrg must be used within an OrgProvider')
  }
  return context
}
