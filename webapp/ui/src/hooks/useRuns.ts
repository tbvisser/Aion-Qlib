/**
 * The run ledger both builders share with their backtests panel.
 *
 * Fetched once on mount and refreshed on demand; a fetch failure says nothing
 * — the index is a convenience, and disturbing the builder over it would cost
 * more than the missing rows do.
 */
import { useCallback, useEffect, useState } from 'react'

import { api, type Run } from '@/lib/api'

export interface RunsState {
  runs: Run[]
  refresh: () => Promise<void>
  /** Delete a finished run. Optimistic, then reconciled — see below. */
  remove: (target: Run) => Promise<void>
}

export function useRuns(onError: (message: string) => void): RunsState {
  const [runs, setRuns] = useState<Run[]>([])

  const refresh = useCallback(async () => {
    try {
      // Explicit, because the server's default is 100 and says nothing about
      // it — a strategy iterated on for an afternoon reaches that, and the
      // ledger then stops showing the early attempts it exists to compare.
      setRuns((await api.listRuns(500)).runs)
    } catch {
      /* the index is a convenience; a failure must not disturb the builder */
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /**
   * Optimistic, then reconciled: the row is the only thing on screen that
   * refers to it, and waiting for a refetch to make a delete look like it
   * happened reads as a broken button.
   */
  const remove = useCallback(async (target: Run) => {
    setRuns((prev) => prev.filter((r) => r.id !== target.id))
    try {
      await api.deleteRun(target.id)
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not delete the run')
    } finally {
      void refresh()
    }
  }, [onError, refresh])

  return { runs, refresh, remove }
}
