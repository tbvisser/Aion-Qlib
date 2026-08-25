import { useEffect, useState } from 'react'
import { ExternalLink, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { api, type VibeHealth } from '@/lib/api'
import { cn } from '@/lib/utils'

const VIBE_CONSOLE_URL = 'http://127.0.0.1:8899'

function StatusDot({ health, online }: { health: unknown; online: boolean }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        health === null
          ? 'animate-subtle-pulse bg-muted-foreground/40'
          : online ? 'bg-primary' : 'bg-destructive',
      )}
    />
  )
}

function ConsoleRow({
  icon: Icon,
  title,
  health,
  online,
  offlineHint,
  description,
  href,
  linkLabel,
}: {
  icon: typeof Sparkles
  title: string
  health: unknown
  online: boolean
  offlineHint: string
  description: string
  href: string
  linkLabel: string
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-foreground/[0.02] text-muted-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{title}</span>
            <StatusDot health={health} online={online} />
            <span className="text-label text-muted-foreground">
              {health === null ? 'checking…' : online ? 'online' : 'offline'}
            </span>
          </div>
          <p className="mt-1 text-caption text-muted-foreground">{description}</p>
        </div>
        <Button asChild size="sm" variant="outline" disabled={!online} className="shrink-0">
          <a href={href} target="_blank" rel="noreferrer">
            {linkLabel} <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
      {!online && health !== null && (
        <p className="rounded-md bg-muted p-2 font-mono text-label text-muted-foreground">
          {offlineHint}
        </p>
      )}
    </div>
  )
}

export function AgentConsolePanel() {
  const [vibeHealth, setVibeHealth] = useState<VibeHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    const probe = () => {
      api.vibeHealth().then(
        (h) => { if (!cancelled) setVibeHealth(h) },
        () => { if (!cancelled) setVibeHealth({ status: 'unreachable' }) },
      )
    }
    probe()
    const timer = setInterval(probe, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  const vibeOnline = vibeHealth?.status === 'ok'

  return (
    <Panel
      title="Agent console"
      hint="Vibe sidecar"
      className="col-span-12"
    >
      <ConsoleRow
        icon={Sparkles}
        title="Vibe Agent console"
        health={vibeHealth}
        online={vibeOnline}
        offlineHint="infra\\stack.ps1 up"
        description="The sidecar's own UI for multi-turn sessions and swarm runs. For questions inside Aion, the dashboard chat already has the same tools over MCP."
        href={VIBE_CONSOLE_URL}
        linkLabel="Open console"
      />
    </Panel>
  )
}
