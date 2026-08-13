import { useCallback, useEffect, useState } from 'react'
import { api, type Project, type ProjectSpec } from '@/lib/api'

/**
 * The project list, in the shape every hook in this folder returns:
 * `{ data, error, loading, refresh }`. See `useHealth` for the reference.
 *
 * `save` and `remove` refresh rather than patching local state. There is no
 * cache layer to invalidate and the list is small; a re-read is the only way to
 * pick up the server's `updated_at`, which is what the list sorts on.
 */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const response = await api.listProjects()
      setProjects(response.projects)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load projects')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const save = useCallback(
    async (spec: ProjectSpec, id?: string) => {
      const saved = await api.saveProject(spec, id)
      await refresh()
      return saved
    },
    [refresh],
  )

  const remove = useCallback(
    async (id: string) => {
      await api.deleteProject(id)
      await refresh()
    },
    [refresh],
  )

  return { projects, error, loading, refresh, save, remove }
}
