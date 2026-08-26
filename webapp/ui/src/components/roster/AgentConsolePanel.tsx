import { useEffect, useState } from 'react'
import { ExternalLink, Bot, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { api, type HermesHealth, type VibeHealth } from '@/lib/api'
import { cn } from '@/lib/utils'

const VIBE_CONSOLE_URL = 'http://127.0.0.1:8899'
const HERMES_DOCS_URL = 'https://hermes-agent.nousresearch.com/docs/user-guide/messaging'

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
  extra,
}: {
  icon: typeof Sparkles
  title: string
  health: unknown
  online: boolean
  offlineHint: string
  description: string
  href: string
  linkLabel: string
  extra?: React.ReactNode
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
              {health === null ? 'checking…' : online ? 'online' : health === 'disabled' ? 'disabled' : 'offline'}
            </span>
          </div>
          <p className="mt-1 text-caption text-muted-foreground">{description}</p>
          {extra}
        </div>
        <Button asChild size="sm" variant="outline" disabled={!online && health !== 'disabled'} className="shrink-0">
          <a href={href} target="_blank" rel="noreferrer">
            {linkLabel} <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
      {!online && health !== null && health !== 'disabled' && (
        <p className="rounded-md bg-muted p-2 font-mono text-label text-muted-foreground">
          {offlineHint}
        </p>
      )}
    </div>
  )
}

export function AgentConsolePanel() {
  const [vibeHealth, setVibeHealth] = useState<VibeHealth | null>(null)
  const [hermesHealth, setHermesHealth] = useState<HermesHealth | null>(null)

  useEffect(() => {
    let cancelled = false
    const probe = () => {
      api.vibeHealth().then(
        (h) => { if (!cancelled) setVibeHealth(h) },
        () => { if (!cancelled) setVibeHealth({ status: 'unreachable' }) },
      )
      api.hermesHealth().then(
        (h) => { if (!cancelled) setHermesHealth(h) },
        () => { if (!cancelled) setHermesHealth({ status: 'unreachable', enabled: true }) },
      )
    }
    probe()
    const timer = setInterval(probe, 30_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  const vibeOnline = vibeHealth?.status === 'ok'
  const hermesOnline = hermesHealth?.status === 'ok'
  const hermesDisabled = hermesHealth?.status === 'disabled'

  return (
    <Panel
      title="Agent consoles"
      hint="Vibe sidecar + optional Hermes gateway"
      className="col-span-12"
    >
      <div className="space-y-6">
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

        <ConsoleRow
          icon={Bot}
          title="Hermes gateway"
          health={hermesDisabled ? 'disabled' : hermesHealth}
          online={hermesOnline}
          offlineHint={'docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d hermes-gateway\n# and HERMES_GATEWAY_ENABLED=true in webapp/.env'}
          description="Nous Hermes Agent orchestrating Aion MCP and Vibe MCP — cross-session memory, cron, and optional Telegram/Discord. Not embedded; configure messaging in hermes/.env."
          href={HERMES_DOCS_URL}
          linkLabel="Setup docs"
          extra={hermesHealth?.mcp_servers?.length ? (
            <p className="mt-2 font-mono text-label text-muted-foreground">
              MCP: {hermesHealth.mcp_servers.join(', ')}
            </p>
          ) : null}
        />
      </div>
    </Panel>
  )
}
