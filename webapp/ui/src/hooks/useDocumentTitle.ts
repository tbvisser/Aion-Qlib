import { useEffect } from 'react'

const SUFFIX = 'Aion'

/**
 * Sets the browser tab title to `"{title} — Aion"`.
 *
 * Wired into `PageHeader` (and through it `IndexHeader`), so any page with a
 * house header gets its tab title for free; pages without one call it
 * directly. Pass nothing to leave the current title alone — a page whose
 * header renders conditionally should not blank the tab while loading.
 */
export function useDocumentTitle(title?: string) {
  useEffect(() => {
    if (!title) return
    document.title = `${title} — ${SUFFIX}`
  }, [title])
}
