/**
 * The saved-strategy list, and the three writes against it.
 *
 * Extracted from `StrategyBuilderPage` when the header gained a switcher: that
 * added duplicate, delete-from-menu and rename-then-update to a page where
 * `refreshSaved` was already declared *below* the callback closing over it. It
 * worked because the call was async, and it is the kind of thing that stops
 * working the moment someone adds an early return.
 *
 * Deliberately thin. `spec`, `currentId` and the dirty baseline stay on the
 * page — the canvas, the assistant, the preview effect and the summary all read
 * `spec`, and a hook that owns it is the page with extra steps.
 */
import { useCallback, useEffect, useState } from 'react'

import { api, type StoredStrategy, type StrategySpec } from '@/lib/api'

export interface UseStrategies {
  saved: StoredStrategy[]
  reload: () => Promise<void>
  save: (spec: StrategySpec, id?: string) => Promise<StoredStrategy>
  remove: (id: string) => Promise<void>
  /** Share with the workspace, or make private again. */
  setVisibility: (id: string, visibility: 'private' | 'org') => Promise<void>
  /** The last write failure, cleared by the next successful write. */
  error: string | null
  /** Find a loaded strategy by id without another fetch. */
  getById: (id: string) => StoredStrategy | undefined
}

export function useStrategies(): UseStrategies {
  const [saved, setSaved] = useState<StoredStrategy[]>([])
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setSaved((await api.listStrategies()).strategies)
    } catch {
      /* the list is a convenience; a failure here must not block building */
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const save = useCallback(async (spec: StrategySpec, id?: string) => {
    try {
      const stored = await api.saveStrategy(spec, id)
      await reload()
      setError(null)
      return stored
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      throw e
    }
  }, [reload])

  const remove = useCallback(async (id: string) => {
    try {
      await api.deleteStrategy(id)
      await reload()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete')
      throw e
    }
  }, [reload])

  const setVisibility = useCallback(
    async (id: string, visibility: 'private' | 'org') => {
      try {
        await api.setStrategyVisibility(id, visibility)
        await reload()
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not change sharing')
        throw e
      }
    }, [reload])

  const getById = useCallback(
    (id: string) => saved.find((s) => s.id === id),
    [saved],
  )

  return { saved, reload, save, remove, setVisibility, error, getById }
}
