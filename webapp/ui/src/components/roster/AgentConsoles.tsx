import { useEffect, useState } from 'react'
import { ExternalLink, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { api, type VibeHealth } from '@/lib/api'
import { cn } from '@/lib/utils'

// The sidecar publishes on 127.0.0.1 only (see docker-compose.yml), so this
// link works exactly where the app itself is reachable in dev. The console
// cannot be iframed — vibe's API sends frame-ancestors 'none' — hence a launch
// card rather than an embed.
const VIBE_CONSOLE_URL = 'http://127.0.0.1:8899'

/**
 * The agent consoles this platform can hand you off to.
 *
 * Today that is one: the Vibe-Trading sidecar's own session and swarm
 * machinery, folded in from the nav row it used to have.
 *
 * It is a card above the Agents table rather than a row in it, and that is the
 * honest shape: every row in that table is a *definition* the roster read from
 * a backend, while this is a running service you leave the app to use. The
 * sidecar sends `frame-ancestors 'none'`, so it cannot be embedded either.
 *
 * The status probe is the point. "Open console" against a dead sidecar opens a
 * connection-refused tab, and the fix — one compose command — is printed here
 * rather than left to be discovered.
 */
export function AgentConsoles() {
  const [health, setHealth] = useState<VibeHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    const probe = () => {
      api.vibeHealth().then(
        (h) => { if (!cancelled) setHealth(h) },
        () => { if (!cancelled) setHealth({ status: 'unreachable' }) },
      )
    }
    probe()
    const timer = setInterval(probe, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  const online = health?.status === 'ok'

  return (
    <Card className="shrink-0">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-medium">Vibe Agent console</span>
              <span
                className={cn(
                  'inline-block h-2 w-2 shrink-0 rounded-full',
                  health === null
                    ? 'animate-subtle-pulse bg-muted-foreground/40'
                    : online ? 'bg-primary' : 'bg-destructive',
                )}
              />
              <span className="text-label text-muted-foreground">
                {health === null ? 'checking…' : online ? 'online' : 'offline'}
              </span>
            </div>
            <p className="mt-1 text-caption text-muted-foreground">
              The sidecar's own UI, where its multi-turn sessions and swarm runs live. The
              teams and tools listed below are the definitions; this is where they execute.
              {/* The distinction worth stating: both exist on purpose, and people
                  otherwise assume one supersedes the other. */}
              {' '}For questions inside Aion, the dashboard chat already has the same tools
              over MCP.
            </p>
          </div>
          <Button asChild size="sm" variant="outline" disabled={!online} className="shrink-0">
            <a href={VIBE_CONSOLE_URL} target="_blank" rel="noreferrer">
              Open console <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </a>
          </Button>
        </div>

        {!online && health !== null && (
          <p className="rounded-md bg-muted p-2 font-mono text-label text-muted-foreground">
            infra\stack.ps1 up
          </p>
        )}
      </CardContent>
    </Card>
  )
}
