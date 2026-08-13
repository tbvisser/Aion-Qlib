/**
 * Who is in this workspace, and how to get someone else in.
 *
 * There is no mail sender in this deployment, so an invite produces a link the
 * admin passes on themselves. Saying that plainly is the honest design: a
 * "Send invite" button that quietly sent nothing would be worse than a link the
 * admin has to copy.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Loader2, Trash2, UserPlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'
import { useOrg } from '@/hooks/useOrg'
import { api, type OrgInvite, type OrgMember, type OrgRole } from '@/lib/api'

function inviteLink(token: string): string {
  return `${window.location.origin}/invite/${token}`
}

export function MembersPage() {
  const { user } = useAuth()
  const { current, isOrgAdmin, loading: orgLoading } = useOrg()
  const [members, setMembers] = useState<OrgMember[]>([])
  const [invites, setInvites] = useState<OrgInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<OrgRole>('member')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!current) return
    setLoading(true)
    try {
      const [m, i] = await Promise.all([
        api.orgMembers(current.id),
        // Only admins may list invites; a member seeing none is correct, not
        // an error worth showing them.
        isOrgAdmin ? api.orgInvites(current.id) : Promise.resolve({ invites: [] }),
      ])
      setMembers(m.members)
      setInvites(i.invites.filter((x) => !x.accepted_at))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the workspace')
    } finally {
      setLoading(false)
    }
  }, [current, isOrgAdmin])

  useEffect(() => { void load() }, [load])

  const invite = async () => {
    if (!current || !email.trim()) return
    setBusy(true)
    try {
      await api.createInvite(current.id, email.trim(), role)
      setEmail('')
      await load()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the invite')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (userId: string) => {
    if (!current) return
    try {
      await api.removeMember(current.id, userId)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove that person')
    }
  }

  const copy = async (token: string) => {
    await navigator.clipboard.writeText(inviteLink(token))
    setCopied(token)
    setTimeout(() => setCopied(null), 2000)
  }

  if (orgLoading || loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">{current?.name ?? 'Workspace'}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {members.length} {members.length === 1 ? 'person' : 'people'}. Everyone
          keeps their own strategies, runs and portfolios private unless they
          share them with the workspace.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <section className="mb-8 rounded-xl border border-border/60">
        {members.map((m) => (
          <div
            key={m.user_id}
            className="flex items-center gap-3 border-b border-border/40 px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {m.is_you ? `${user?.email ?? 'You'} (you)` : m.user_id}
              </p>
              <p className="text-xs text-muted-foreground">
                Joined {new Date(m.joined_at).toLocaleDateString()}
              </p>
            </div>
            <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">
              {m.role}
            </span>
            {(isOrgAdmin || m.is_you) && m.role !== 'owner' && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => void remove(m.user_id)}
                title={m.is_you ? 'Leave this workspace' : 'Remove from workspace'}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
      </section>

      {isOrgAdmin && (
        <section>
          <h2 className="mb-2 text-sm font-medium">Invite someone</h2>
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void invite() }}
              placeholder="colleague@company.com"
              className="h-9 min-w-0 flex-1 rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:border-foreground/30"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as OrgRole)}
              className="h-9 rounded-lg border border-border/60 bg-background px-2 text-sm outline-none"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <Button onClick={() => void invite()} disabled={busy || !email.trim()}>
              <UserPlus className="mr-1.5 h-4 w-4" />
              Invite
            </Button>
          </div>

          {invites.length > 0 && (
            <div className="mt-4 rounded-xl border border-border/60">
              <p className="border-b border-border/40 px-4 py-2 text-xs text-muted-foreground">
                Pending invites. No email is sent from this deployment — copy the
                link and send it yourself.
              </p>
              {invites.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center gap-3 border-b border-border/40 px-4 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{inv.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {inv.role} · expires {new Date(inv.expires_at).toLocaleDateString()}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void copy(inv.token)}>
                    {copied === inv.token ? (
                      <><Check className="mr-1.5 h-3.5 w-3.5 text-emerald-500" />Copied</>
                    ) : (
                      <><Copy className="mr-1.5 h-3.5 w-3.5" />Copy link</>
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
