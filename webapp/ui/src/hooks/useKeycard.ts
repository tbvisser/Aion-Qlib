import { useCallback, useState } from 'react'

import { api, type Keycard, type KeycardSpec } from '@/lib/api'

/**
 * A stored keycard carries metadata fields the compiler and save endpoints do
 * not accept. Keep the in-editor spec strictly limited to the spec shape so it
 * round-trips cleanly.
 */
export function toKeycardSpec(k: Keycard | KeycardSpec): KeycardSpec {
  const {
    name, description, tags, is_template, template_family, nodes, edges, windows,
  } = k
  return { name, description, tags, is_template, template_family, nodes, edges, windows }
}

export interface UseKeycard {
  spec: KeycardSpec
  baseline: KeycardSpec
  currentId: string | undefined
  loading: boolean
  error: string | null
  load: (id: string) => Promise<void>
  save: () => Promise<{ stored: Keycard | null; error: string | null }>
  fork: () => Promise<Keycard | null>
  remove: () => Promise<boolean>
  reset: (spec?: KeycardSpec) => void
}

export function useKeycard(initial: KeycardSpec): UseKeycard {
  const [spec, setSpec] = useState<KeycardSpec>(initial)
  const [baseline, setBaseline] = useState<KeycardSpec>(initial)
  const [currentId, setCurrentId] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const k = await api.getKeycard(id)
      const spec = toKeycardSpec(k)
      setSpec(spec)
      setBaseline(spec)
      setCurrentId(k.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load keycard')
    } finally {
      setLoading(false)
    }
  }, [])

  const save = useCallback(async (): Promise<{ stored: Keycard | null; error: string | null }> => {
    setLoading(true)
    setError(null)
    try {
      const cleanSpec = toKeycardSpec(spec)
      const stored = currentId
        ? await api.updateKeycard(currentId, cleanSpec)
        : await api.createKeycard(cleanSpec)
      setBaseline(toKeycardSpec(stored))
      setCurrentId(stored.id)
      return { stored, error: null }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to save keycard'
      setError(message)
      return { stored: null, error: message }
    } finally {
      setLoading(false)
    }
  }, [spec, currentId])

  const fork = useCallback(async (): Promise<Keycard | null> => {
    if (!currentId) return null
    setLoading(true)
    setError(null)
    try {
      const forked = await api.forkKeycard(currentId)
      const spec = toKeycardSpec(forked)
      setSpec(spec)
      setBaseline(spec)
      setCurrentId(forked.id)
      return forked
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fork keycard')
      return null
    } finally {
      setLoading(false)
    }
  }, [currentId])

  const remove = useCallback(async (): Promise<boolean> => {
    if (!currentId) return false
    setLoading(true)
    setError(null)
    try {
      await api.deleteKeycard(currentId)
      setCurrentId(undefined)
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete keycard')
      return false
    } finally {
      setLoading(false)
    }
  }, [currentId])

  const reset = useCallback((next: KeycardSpec = initial) => {
    setSpec(next)
    setBaseline(next)
    setCurrentId(undefined)
    setError(null)
  }, [initial])

  return {
    spec,
    baseline,
    currentId,
    loading,
    error,
    load,
    save,
    fork,
    remove,
    reset,
  }
}
