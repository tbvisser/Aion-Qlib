import { useCallback, useEffect, useState } from 'react'
import { api, type VibeShadowResult } from '@/lib/api'

const LS_KEY = 'aion.shadow.lastProfile'

interface PersistedProfile {
  journalPath: string
  shadowId: string
}

function readStoredProfile(): PersistedProfile | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as PersistedProfile) : null
  } catch {
    return null
  }
}

export function useShadowAccounts() {
  const [journalPath, setJournalPath] = useState<string | null>(
    () => readStoredProfile()?.journalPath ?? null,
  )
  const [shadowId, setShadowId] = useState<string | null>(
    () => readStoredProfile()?.shadowId ?? null,
  )
  const [filename, setFilename] = useState<string | null>(null)
  const [rules, setRules] = useState<unknown[]>([])
  const [backtestResult, setBacktestResult] = useState<VibeShadowResult | null>(null)
  const [scanResult, setScanResult] = useState<VibeShadowResult | null>(null)
  const [reportUrl, setReportUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Persist shadow_id + journal_path so a page refresh doesn't lose the profile.
  useEffect(() => {
    if (journalPath && shadowId) {
      localStorage.setItem(LS_KEY, JSON.stringify({ journalPath, shadowId }))
    }
  }, [journalPath, shadowId])

  /** Upload a broker trade-journal export (.csv/.xls/.xlsx). Sets journalPath. */
  const upload = useCallback(async (file: File) => {
    setBusy('upload')
    setError(null)
    try {
      const res = await api.vibeJournalUpload(file)
      setJournalPath(res.file_path)
      setFilename(res.filename)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(null)
    }
  }, [])

  /** Parse/validate the uploaded journal — call before extract. */
  const analyze = useCallback(async () => {
    if (!journalPath) return
    setBusy('analyze')
    setError(null)
    try {
      const res = await api.vibeJournalAnalyze(journalPath)
      if (res.result.status === 'error') {
        setError(res.result.error ?? 'Journal analysis failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setBusy(null)
    }
  }, [journalPath])

  /** Mine profitable roundtrips into if-then rules. Sets shadowId + rules. */
  const extract = useCallback(
    async (opts: { min_support?: number; max_rules?: number } = {}) => {
      if (!journalPath) return
      setBusy('extract')
      setError(null)
      try {
        const res = await api.vibeShadowExtract(journalPath, opts)
        const payload = res.result
        if (payload.status === 'error') {
          setError(payload.error ?? 'Extract failed')
          return
        }
        if (payload.shadow_id) setShadowId(payload.shadow_id)
        const r = payload['rules']
        setRules(Array.isArray(r) ? r : [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Extract failed')
      } finally {
        setBusy(null)
      }
    },
    [journalPath],
  )

  /** Back-test the rule set across a date window and optional market list. */
  const backtest = useCallback(
    async (
      opts: {
        window_start?: string
        window_end?: string
        markets?: string[]
      } = {},
    ) => {
      if (!shadowId) return
      setBusy('backtest')
      setError(null)
      try {
        const res = await api.vibeShadowBacktest(shadowId, opts)
        setBacktestResult(res.result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Backtest failed')
      } finally {
        setBusy(null)
      }
    },
    [shadowId],
  )

  /** Scan today's market for symbols that match the entry cadence. */
  const scan = useCallback(
    async (opts: { date?: string; per_market?: number } = {}) => {
      if (!shadowId) return
      setBusy('scan')
      setError(null)
      try {
        const res = await api.vibeShadowScan(shadowId, opts)
        setScanResult(res.result)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Scan failed')
      } finally {
        setBusy(null)
      }
    },
    [shadowId],
  )

  /** Trigger the full 8-section HTML report render inside the sidecar. */
  const render = useCallback(async () => {
    if (!shadowId) return
    setBusy('render')
    setError(null)
    try {
      await api.vibeShadowRender(shadowId)
      setReportUrl(api.vibeShadowReportUrl(shadowId, 'html'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Render failed')
    } finally {
      setBusy(null)
    }
  }, [shadowId])

  /** Clear all state and remove the persisted profile. */
  const reset = useCallback(() => {
    setJournalPath(null)
    setShadowId(null)
    setFilename(null)
    setRules([])
    setBacktestResult(null)
    setScanResult(null)
    setReportUrl(null)
    setError(null)
    setBusy(null)
    localStorage.removeItem(LS_KEY)
  }, [])

  return {
    upload,
    analyze,
    extract,
    backtest,
    scan,
    render,
    reset,
    journalPath,
    filename,
    shadowId,
    rules,
    backtestResult,
    scanResult,
    reportUrl,
    busy,
    error,
  }
}
