import { useEffect, useState } from 'react'

import { api, type Indicator } from '@/lib/api'

/**
 * Whether each indicator can actually run against the mounted store.
 *
 * The catalog index is machine-independent by construction — the same rows on a
 * laptop that has never built a store — so runnability cannot live in it. It is
 * a judgement about *this* machine, and `GET /api/indicators` is what makes it.
 * This hook fetches that judgement once and hands back a lookup, so the catalog
 * table can carry the mark without the index pretending to know it.
 *
 * The claim worth preserving is `deadAndTrainedOn`. qlib returns an empty series
 * for a missing column rather than failing, so an indicator reading `$vwap` on a
 * store that has no `$vwap` evaluates to NaN on every row, silently. When that
 * indicator is also one of the 158 the Alpha158 handler trains on — `VWAP0` is,
 * on both stores here — every strategy using that handler is fitting against a
 * dead column, to the end of the backtest, without a word anywhere. That
 * sentence was the Indicators page's headline banner and it must not be lost
 * when the page folds in.
 */
export interface StoreMark {
  /** Null when there is no store to judge against — unknown, not runnable. */
  runnable: boolean | null
  note?: string
  proxyFields?: string[]
  inHandler: boolean
}

export interface StoreMarks {
  byName: Map<string, StoreMark>
  /** Indicators that are dead here *and* part of the handler's own 158. */
  deadAndTrainedOn: string[]
  missingColumns: string[]
  providerUri: string | null
  checked: boolean
  loading: boolean
}

const EMPTY: StoreMarks = {
  byName: new Map(),
  deadAndTrainedOn: [],
  missingColumns: [],
  providerUri: null,
  checked: false,
  loading: false,
}

export function useStoreMarks(store?: string): StoreMarks {
  const [marks, setMarks] = useState<StoreMarks | null>(null)

  useEffect(() => {
    let cancelled = false
    setMarks(null)
    api.indicators(store)
      .then((payload) => {
        if (cancelled) return
        const byName = new Map<string, StoreMark>()
        for (const indicator of payload.indicators) {
          byName.set(indicator.name, {
            runnable: indicator.runnable ?? null,
            note: indicator.note,
            proxyFields: indicator.proxy_fields,
            inHandler: indicator.in_handler,
          })
        }
        setMarks({
          byName,
          deadAndTrainedOn: payload.indicators
            .filter((i: Indicator) => i.runnable === false && i.in_handler)
            .map((i: Indicator) => i.name),
          missingColumns: payload.store.missing_columns,
          providerUri: payload.store.provider_uri,
          checked: payload.store.checked,
          loading: false,
        })
      })
      // Silently unknown rather than wrong. A failed judgement must not render
      // as "runs fine": the table simply carries no mark.
      .catch(() => { if (!cancelled) setMarks(EMPTY) })
    return () => { cancelled = true }
  }, [store])

  return marks ?? { ...EMPTY, loading: true }
}
