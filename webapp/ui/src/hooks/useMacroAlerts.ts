import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type MacroCalendar } from '@/lib/api'
import { aggregateAlerts, type MacroAlertPoint } from '@/lib/macroAlerts'
import { addDaysIso, todayIso } from '@/lib/macroFormat'

const HORIZON_DAYS = 14

export function useMacroAlerts(enabled = true) {
  const [alerts, setAlerts] = useState<MacroAlertPoint[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const reqId = useRef(0)

  const refresh = useCallback(() => {
    if (!enabled) {
      setAlerts([])
      setLoading(false)
      setError(null)
      return
    }

    const id = ++reqId.current
    setLoading(true)
    setError(null)

    const from = todayIso()
    const to = addDaysIso(from, HORIZON_DAYS)

    void api
      .macroCalendar({ from, to, limit: 1000 })
      .then((calendar: MacroCalendar) => {
        if (id !== reqId.current) return
        setAlerts(aggregateAlerts(calendar, HORIZON_DAYS))
        setError(null)
      })
      .catch((err) => {
        if (id !== reqId.current) return
        setAlerts([])
        setError(err instanceof Error ? err.message : 'Failed to load alerts')
      })
      .finally(() => {
        if (id === reqId.current) setLoading(false)
      })
  }, [enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { alerts, loading, error, refresh }
}
