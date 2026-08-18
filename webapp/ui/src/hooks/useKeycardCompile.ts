import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, api, type KeycardCompileResult, type KeycardSpec } from '@/lib/api'

const DEBOUNCE_MS = 400

function isOfflineError(e: unknown): boolean {
  if (e instanceof ApiError) {
    // 404 from /api/keycards/compile means the backend package has not been
    // deployed or the migration has not run. Treat it as offline rather than
    // a validation failure so the UI doesn't flash "Preview unavailable".
    return e.status === 404
  }
  if (e instanceof TypeError) {
    // fetch throws TypeError for network failures (server down, CORS, etc).
    return true
  }
  return false
}

export interface UseKeycardCompile {
  yaml: string | null
  defects: KeycardCompileResult['defects']
  warnings: string[]
  loading: boolean
  error: string | null
  offline: boolean
  compile: () => Promise<void>
}

export function useKeycardCompile(spec: KeycardSpec): UseKeycardCompile {
  const [yaml, setYaml] = useState<string | null>(null)
  const [defects, setDefects] = useState<KeycardCompileResult['defects']>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const compile = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.compileKeycard(spec)
      setYaml(result.yaml)
      setDefects(result.defects)
      setWarnings(result.warnings)
      setOffline(false)
    } catch (e) {
      if (isOfflineError(e)) {
        setOffline(true)
        setError(null)
      } else {
        setError(e instanceof Error ? e.message : 'Compile failed')
        setOffline(false)
      }
      setYaml(null)
    } finally {
      setLoading(false)
    }
  }, [spec])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      void compile()
    }, DEBOUNCE_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [compile])

  return { yaml, defects, warnings, loading, error, offline, compile }
}
