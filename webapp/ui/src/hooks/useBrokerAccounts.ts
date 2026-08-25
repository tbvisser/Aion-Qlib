import { useCallback, useEffect, useState } from 'react'
import {
  api,
  type VibeBrokerConnections,
  type VibeBrokerResult,
  type VibeHealth,
} from '@/lib/api'

export interface BrokerAccountsState {
  health: VibeHealth | null
  connections: VibeBrokerConnections | null
  account: VibeBrokerResult | null
  positions: VibeBrokerResult | null
  orders: VibeBrokerResult | null
  history: VibeBrokerResult | null
  error: string | null
  loading: boolean
  refresh: () => void
  select: (profileId: string) => Promise<void>
}

export function useBrokerAccounts(): BrokerAccountsState {
  const [health, setHealth] = useState<VibeHealth | null>(null)
  const [connections, setConnections] = useState<VibeBrokerConnections | null>(null)
  const [account, setAccount] = useState<VibeBrokerResult | null>(null)
  const [positions, setPositions] = useState<VibeBrokerResult | null>(null)
  const [orders, setOrders] = useState<VibeBrokerResult | null>(null)
  const [history, setHistory] = useState<VibeBrokerResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Increment to trigger a re-fetch without changing the hook's API.
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => { setTick((n) => n + 1) }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    void (async () => {
      // Step 1: health check — if unreachable, short-circuit everything.
      try {
        const h = await api.vibeHealth()
        if (cancelled) return
        setHealth(h)
        if (h.status === 'unreachable') {
          setError('unreachable')
          setLoading(false)
          return
        }
      } catch {
        if (cancelled) return
        setHealth({ status: 'unreachable' })
        setError('unreachable')
        setLoading(false)
        return
      }

      // Step 2: broker connections list.
      try {
        const { result: conn } = await api.vibeBrokerConnections()
        if (cancelled) return
        setConnections(conn)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not load broker connections')
        setLoading(false)
        return
      }

      // Step 3: four data calls in parallel — one failing must not blank the rest.
      const [acct, pos, ord, hist] = await Promise.allSettled([
        api.vibeBrokerAccount(),
        api.vibeBrokerPositions(),
        api.vibeBrokerOrders(),
        api.vibeBrokerHistory(),
      ])
      if (cancelled) return

      setAccount(acct.status === 'fulfilled' ? acct.value.result : { status: 'error', error: String((acct as PromiseRejectedResult).reason) })
      setPositions(pos.status === 'fulfilled' ? pos.value.result : { status: 'error', error: String((pos as PromiseRejectedResult).reason) })
      setOrders(ord.status === 'fulfilled' ? ord.value.result : { status: 'error', error: String((ord as PromiseRejectedResult).reason) })
      setHistory(hist.status === 'fulfilled' ? hist.value.result : { status: 'error', error: String((hist as PromiseRejectedResult).reason) })

      if (!cancelled) setLoading(false)
    })()

    return () => { cancelled = true }
  }, [tick])

  const select = useCallback(async (profileId: string) => {
    await api.vibeBrokerSelect(profileId)
    refresh()
  }, [refresh])

  return { health, connections, account, positions, orders, history, error, loading, refresh, select }
}
