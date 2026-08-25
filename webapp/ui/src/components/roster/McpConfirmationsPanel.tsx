import { useCallback, useEffect, useState } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { api, type McpConfirmation } from '@/lib/api'

export function McpConfirmationsPanel() {
  const [rows, setRows] = useState<McpConfirmation[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    api.mcpConfirmations()
      .then((r) => setRows(r.confirmations))
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 20_000)
    return () => clearInterval(timer)
  }, [refresh])

  async function approve(id: string) {
    setBusyId(id)
    try {
      await api.mcpConfirmationApprove(id)
      refresh()
    } finally {
      setBusyId(null)
    }
  }

  async function reject(id: string) {
    setBusyId(id)
    try {
      await api.mcpConfirmationReject(id)
      refresh()
    } finally {
      setBusyId(null)
    }
  }

  if (loading && rows.length === 0) {
    return (
      <Panel title="MCP approvals" hint="Tier-1 tools from Hermes / external MCP hosts" className="col-span-12">
        <p className="text-caption text-muted-foreground">Loading…</p>
      </Panel>
    )
  }

  if (rows.length === 0) {
    return null
  }

  return (
    <Panel title="MCP approvals" hint="Confirm expensive actions requested via Hermes MCP" className="col-span-12">
      <ul className="space-y-3">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border/50 bg-foreground/[0.02] p-3"
          >
            <div className="min-w-0 flex-1">
              <div className="font-mono text-label text-muted-foreground">{row.tool}</div>
              <div className="text-caption text-foreground">{row.summary}</div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === row.id}
                onClick={() => reject(row.id)}
              >
                <X className="mr-1 h-3.5 w-3.5" /> Reject
              </Button>
              <Button
                size="sm"
                disabled={busyId === row.id}
                onClick={() => approve(row.id)}
              >
                <Check className="mr-1 h-3.5 w-3.5" /> Approve
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
