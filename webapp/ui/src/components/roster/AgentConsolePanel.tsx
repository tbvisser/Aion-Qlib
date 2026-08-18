import { useEffect, useState } from 'react'
import { ExternalLink, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { api, type VibeHealth } from '@/lib/api'
import { cn } from '@/lib/utils'

const VIBE_CONSOLE_URL = 'http://127.0.0.1:8899'

export function AgentConsolePanel() {
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
    <Panel
      title="Agent console"
      hint="Vibe sidecar"
      className="col-span-12"
      actions={(
        <Button asChild size="sm" variant="outline" disabled={!online}>
          <a href={VIBE_CONSOLE_URL} target="_blank" rel="noreferrer">
            Open console <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
          </a>
        </Button>
      )}
    >
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-foreground/[0.02] text-muted-foreground">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">Vibe Agent console</span>
              <span
                className={cn(
                  'inline-block h-2 w-2 shrink-0 rounded-full',
                  health === null
                    ? 'animate-subtle-pulse bg-muted-foreground/40'
                    : online ? 'bg-emerald-500' : 'bg-destructive',
                )}
              />
              <span className="text-[11px] text-muted-foreground">
                {health === null ? 'checking…' : online ? 'online' : 'offline'}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              The sidecar's own UI, where its multi-turn sessions and swarm runs live. The
              teams and tools listed below are the definitions; this is where they execute.
              {' '}For questions inside Aion, the dashboard chat already has the same tools
              over MCP.
            </p>
          </div>
        </div>

        {!online && health !== null && (
          <p className="rounded-md bg-muted p-2 font-mono text-[11px] text-muted-foreground">
            infra\stack.ps1 up
          </p>
        )}
      </div>
    </Panel>
  )
}
