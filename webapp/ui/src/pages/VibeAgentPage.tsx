import { useEffect, useState } from 'react'
import { ExternalLink, Sparkles } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { api, type VibeHealth } from '@/lib/api'

// The sidecar publishes on 127.0.0.1 only (see docker-compose.yml), so this
// link works exactly where the app itself is reachable in dev. The console
// cannot be iframed — vibe's API sends frame-ancestors 'none' — hence a
// launch page rather than an embed.
const VIBE_CONSOLE_URL = 'http://127.0.0.1:8899'

/**
 * Status + launcher for the Vibe-Trading agent console: their own multi-turn
 * research agent with 47+ tools and preset multi-agent swarms (investment
 * committee, quant desk, risk committee…), served same-origin by the sidecar.
 *
 * This coexists deliberately with our RAG chat: the dashboard chat has the
 * same vibe tools available through MCP for questions inside AION, while the
 * full console is where vibe's own session/swarm machinery lives.
 */
export function VibeAgentPage() {
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
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Vibe Agent"
        description="The Vibe-Trading sidecar's agent console — research sessions, tool calls and multi-agent swarms."
        actions={
          <Button asChild disabled={!online}>
            <a href={VIBE_CONSOLE_URL} target="_blank" rel="noreferrer">
              Open console <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </a>
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="rounded-lg border border-border/50 p-5">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  health === null
                    ? 'animate-subtle-pulse bg-muted-foreground/40'
                    : online
                      ? 'bg-emerald-500'
                      : 'bg-destructive'
                }`}
              />
              <span className="text-sm font-medium">
                {health === null ? 'Checking sidecar…' : online ? 'Sidecar online' : 'Sidecar offline'}
              </span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">{VIBE_CONSOLE_URL}</span>
            </div>
            {!online && health !== null && (
              <p className="mt-3 rounded-md bg-muted p-3 font-mono text-[11px] text-muted-foreground">
                docker compose up -d vibe-api vibe-mcp
              </p>
            )}
          </div>

          <div className="rounded-lg border border-border/50 p-5 text-sm text-muted-foreground">
            <div className="mb-2 flex items-center gap-2 text-foreground">
              <Sparkles className="h-4 w-4" />
              <span className="font-medium">What lives here</span>
            </div>
            <p>
              The console is Vibe-Trading's own UI, served by the sidecar itself. It runs multi-turn
              research sessions against 47+ tools (market data, backtests, risk analysis) and preset
              swarms — investment committee, quant desk, risk committee, value investing, technical
              analysis. Sessions and memory persist in the sidecar's own volume.
            </p>
            <p className="mt-2">
              Sign in with the <code className="font-mono text-[11px]">API_AUTH_KEY</code> from{' '}
              <code className="font-mono text-[11px]">vibe/.env</code>. The agent needs an LLM key
              (for example <code className="font-mono text-[11px]">ANTHROPIC_API_KEY</code>) in the same file.
            </p>
            <p className="mt-2">
              For questions inside AION, the dashboard chat has the same vibe tools available through
              MCP — this console is for vibe's own session and swarm machinery.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
