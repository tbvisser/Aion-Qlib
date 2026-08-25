import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type MacroCalendar, type MacroSnapshot } from '@/lib/api'
import { aggregateAlerts, aggregateMarketAlerts, blendAlerts, type MacroAlertPoint } from '@/lib/macroAlerts'
import { addDaysIso, todayIso } from '@/lib/macroFormat'

const HORIZON_DAYS = 14
const MARKET_WEIGHT = 0.65

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

    void Promise.all([
      api.macroCalendar({ from, to, limit: 1000 }),
      api.macroSnapshot(),
    ])
      .then(([calendar, snapshot]: [MacroCalendar, MacroSnapshot]) => {
        if (id !== reqId.current) return
        const calendarAlerts = aggregateAlerts(calendar, HORIZON_DAYS)
        const marketAlerts = aggregateMarketAlerts(snapshot)
        setAlerts(blendAlerts(calendarAlerts, marketAlerts, MARKET_WEIGHT))
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
