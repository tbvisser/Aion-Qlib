/**
 * Redeem a workspace invite link.
 *
 * Reached at /invite/:token. The app's auth gate wraps every route, so an
 * invitee who is not signed in lands on the login screen first and returns here
 * afterwards — which is what we want: the backend checks the invite against the
 * signed-in account's own verified email, so there is nothing to redeem until
 * someone is signed in.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { useOrg } from '@/hooks/useOrg'
import { api } from '@/lib/api'

export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>()
  const { user } = useAuth()
  const { switchOrg, refresh } = useOrg()
  const navigate = useNavigate()
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working')
  const [message, setMessage] = useState('')
  const [orgId, setOrgId] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    void api.acceptInvite(token)
      .then(async (r) => {
        if (cancelled) return
        setOrgId(r.org_id)
        await refresh()
        setState('done')
      })
      .catch((e) => {
        if (cancelled) return
        // The backend distinguishes expired, already-used and wrong-address.
        // Show which — "invalid invite" leaves the person with nothing to do.
        setMessage(e instanceof Error ? e.message : 'That invite could not be used.')
        setState('failed')
      })
    return () => { cancelled = true }
  }, [token, refresh])

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        {state === 'working' && (
          <>
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">Joining the workspace…</p>
          </>
        )}

        {state === 'done' && (
          <>
            <CheckCircle2 className="mx-auto h-7 w-7 text-primary" />
            <h1 className="mt-3 text-lg font-semibold">You're in</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Anything colleagues have shared with this workspace is now visible
              to you. Your own work stays private unless you share it.
            </p>
            <Button
              className="mt-4"
              onClick={() => { if (orgId) void switchOrg(orgId); else navigate('/dashboard') }}
            >
              Open the workspace
            </Button>
          </>
        )}

        {state === 'failed' && (
          <>
            <XCircle className="mx-auto h-7 w-7 text-destructive" />
            <h1 className="mt-3 text-lg font-semibold">That invite did not work</h1>
            <p className="mt-1 text-sm text-muted-foreground">{message}</p>
            {user?.email && (
              <p className="mt-2 text-xs text-muted-foreground">
                You are signed in as {user.email}. An invite only works for the
                address it was sent to.
              </p>
            )}
            <Button variant="outline" className="mt-4" onClick={() => navigate('/dashboard')}>
              Go to the dashboard
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
