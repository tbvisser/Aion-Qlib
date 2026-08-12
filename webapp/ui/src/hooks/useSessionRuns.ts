/**
 * Run ids launched from this tab, newest first.
 *
 * Kept in sessionStorage so a reload mid-backtest still lands on the running
 * run instead of an empty panel — but scoped to the tab, so it does not leak
 * into a second builder window.
 *
 * Moved out of `RunDock` when the dock and the backtest ledger merged. The
 * logic is unchanged; only the storage key moved with it, because a key still
 * called `runDock` would be a lie the next person has to untangle.
 */
import { useCallback, useMemo, useState } from 'react'

import type { Run } from '@/lib/api'

const SESSION_KEY = 'aion.backtests.sessionRuns'
/** Enough to survive a burst of attempts; the ledger itself is the archive. */
const LIMIT = 8

export interface SessionRuns {
  ids: string[]
  /** The Run `startRun` returned, shown before the stream has said anything. */
  seed: Run | null
  add: (run: Run) => void
}

export function useSessionRuns(): SessionRuns {
  const [ids, setIds] = useState<string[]>(readSessionRuns)
  const [seed, setSeed] = useState<Run | null>(null)

  const add = useCallback((run: Run) => {
    setSeed(run)
    setIds((prev) => {
      const next = [run.id, ...prev.filter((id) => id !== run.id)].slice(0, LIMIT)
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  return useMemo(() => ({ ids, seed, add }), [ids, seed, add])
}

function readSessionRuns(): string[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}
