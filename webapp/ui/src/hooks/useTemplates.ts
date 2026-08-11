import { useEffect, useState } from 'react'
import { api, type TemplatesResponse } from '@/lib/api'

/**
 * The template gallery, fetched once per page load.
 *
 * Cached at module level rather than per component because the request is
 * expensive on the server -- every template is lowered against this machine,
 * which resolves stores, universes and installed models -- and the gallery is a
 * dialog. A dialog that spends seconds fetching on first click is a dialog
 * nobody opens twice, so the builder kicks this off on mount and the click just
 * reads the resolved value.
 */
let inflight: Promise<TemplatesResponse> | null = null

export function loadTemplates(): Promise<TemplatesResponse> {
  inflight ??= api.templates().catch((e) => {
    // Not cached on failure: a template list that fails once must not be
    // permanently empty for the rest of the session.
    inflight = null
    throw e
  })
  return inflight
}

export function useTemplates() {
  const [data, setData] = useState<TemplatesResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadTemplates()
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load'))
    return () => { cancelled = true }
  }, [])

  return { data, error, loading: !data && !error }
}
