import { useCallback, useEffect, useState } from 'react'
import { api, type Run } from '@/lib/api'
import { supabase } from '@/lib/supabase'
import {
  getSandboxFileDownloadUrl,
  getWorkspaceFileDownloadUrl,
} from '@/features/rag/lib/api'

/**
 * Everything this app has generated, on one shelf.
 *
 * Three sources with nothing in common but the fact that a user made them:
 * finished backtests (`/api/runs`), the rendered shadow report (the Vibe
 * sidecar), and the files agents wrote (Supabase). They do not share a
 * transport — `lib/api.ts` is unauthenticated `/api/*`, the RAG client carries
 * a Supabase JWT, and the storage tables are read straight off the browser
 * client with RLS as the boundary — so this fans out with `allSettled` and each
 * source degrades on its own. A dead RAG API costs the Files tab, not the page.
 *
 * `href` resolves lazily where it has to: a storage object's URL is signed and
 * short-lived, so minting one per card at list time would be dozens of requests
 * for links mostly never clicked.
 */

export type ArtifactKind = 'backtest' | 'report' | 'file'

export interface Artifact {
  id: string
  kind: ArtifactKind
  title: string
  /** Where it came from, in one word: the card's second line. */
  source: string
  updatedAt: string
  /** An in-app route, resolved now. Mutually exclusive with `resolveHref`. */
  route?: string
  /** A signed or external URL, minted on click. */
  resolveHref?: () => Promise<string>
  /** Present on backtests, for the metrics preview. */
  run?: Run
  /** Present on files, for the glyph and the caption. */
  contentType?: string | null
}

const SHADOW_KEY = 'aion.shadow.lastProfile'

/** The one shadow profile the app keeps, or null. See `useShadowAccounts`. */
function shadowArtifact(): Artifact | null {
  try {
    const raw = localStorage.getItem(SHADOW_KEY)
    if (!raw) return null
    const profile = JSON.parse(raw) as { shadowId?: string; journalPath?: string }
    if (!profile.shadowId) return null
    return {
      id: `shadow:${profile.shadowId}`,
      kind: 'report',
      title: 'Shadow account report',
      source: 'vibe',
      // The sidecar does not date its reports and there is no list endpoint to
      // ask, so this sorts last rather than claiming a time it does not know.
      updatedAt: '',
      resolveHref: async () => {
        await api.vibeShadowRender(profile.shadowId!)
        return api.vibeShadowReportUrl(profile.shadowId!, 'html')
      },
    }
  } catch {
    return null
  }
}

async function backtestArtifacts(): Promise<Artifact[]> {
  const { runs } = await api.listRuns(60)
  return runs.map((run) => ({
    id: `run:${run.id}`,
    kind: 'backtest' as const,
    title: run.name,
    source: 'backtest',
    updatedAt: run.finished_at ?? run.started_at ?? run.created_at,
    route: `/runs/${run.id}`,
    run,
  }))
}

async function fileArtifacts(): Promise<Artifact[]> {
  const [workspace, sandbox] = await Promise.allSettled([
    supabase
      .from('workspace_files')
      .select('id, thread_id, file_path, content_type, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50),
    supabase
      .from('sandbox_files')
      .select('id, filename, content_type, created_at')
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  const out: Artifact[] = []

  if (workspace.status === 'fulfilled' && workspace.value.data) {
    for (const row of workspace.value.data) {
      out.push({
        id: `workspace:${row.id}`,
        kind: 'file',
        // The path is the name here: two threads can both hold a `plot.png`.
        title: row.file_path,
        source: 'workspace',
        updatedAt: row.updated_at,
        contentType: row.content_type,
        resolveHref: () => getWorkspaceFileDownloadUrl(row.thread_id, row.file_path),
      })
    }
  }

  if (sandbox.status === 'fulfilled' && sandbox.value.data) {
    for (const row of sandbox.value.data) {
      out.push({
        id: `sandbox:${row.id}`,
        kind: 'file',
        title: row.filename,
        source: 'sandbox',
        updatedAt: row.created_at,
        contentType: row.content_type,
        resolveHref: async () => (await getSandboxFileDownloadUrl(row.id)).download_url,
      })
    }
  }

  return out
}

export interface ArtifactSourceErrors {
  backtests: string | null
  files: string | null
}

export function useArtifacts() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [errors, setErrors] = useState<ArtifactSourceErrors>({ backtests: null, files: null })
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [runs, files] = await Promise.allSettled([backtestArtifacts(), fileArtifacts()])

    const collected: Artifact[] = []
    const next: ArtifactSourceErrors = { backtests: null, files: null }

    if (runs.status === 'fulfilled') collected.push(...runs.value)
    else next.backtests = 'Backtests could not be loaded.'

    if (files.status === 'fulfilled') collected.push(...files.value)
    else next.files = 'Agent files could not be loaded.'

    const shadow = shadowArtifact()
    if (shadow) collected.push(shadow)

    // Undated artifacts sort last rather than to the top, which is where an
    // empty string would otherwise put them under a descending compare.
    collected.sort((a, b) => {
      if (!a.updatedAt) return 1
      if (!b.updatedAt) return -1
      return b.updatedAt.localeCompare(a.updatedAt)
    })

    setArtifacts(collected)
    setErrors(next)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { artifacts, errors, loading, refresh }
}
