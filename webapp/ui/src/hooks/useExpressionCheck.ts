import { useEffect, useState } from 'react'

import { api, type ExpressionValidation } from '@/lib/api'
import { hasHole } from '@/lib/factorExpr/serialize'

/**
 * The server's verdict on an expression, while it is still being drawn.
 *
 * `POST /factors/validate` costs ~160µs, touches no store and does not need
 * qlib initialised — its own docblock says it "can be called while an expression
 * is still being drawn". Nothing in the app had ever called it. The canvas
 * validated names and completeness client-side and discovered lookahead,
 * unbounded history and unknown fields only when Run was refused.
 *
 * Three things keep it from becoming noise:
 *
 * **Holes are skipped.** An unfinished tree serialises with a `?` and would come
 * back `invalid` on every keystroke of normal building. `featureSet.ts` already
 * documents making exactly this mistake once, with the `incomplete` severity.
 *
 * **Cached by `store::expression`.** Tab-switching, undo and redo are then free,
 * and two columns holding the same expression cost one request.
 *
 * **Race-guarded.** A slow answer for a half-typed expression must not overwrite
 * a fast answer for the finished one.
 */
const cache = new Map<string, Promise<ExpressionValidation>>()

const key = (expression: string, store?: string) => `${store ?? ''}::${expression}`

export function checkExpression(
  expression: string, store?: string,
): Promise<ExpressionValidation> {
  const k = key(expression, store)
  let inflight = cache.get(k)
  if (!inflight) {
    inflight = api.validateExpression({ expression, role: 'feature', store })
      .catch((e) => {
        // Not cached on failure. A refusal is a verdict; a dropped request is
        // not, and must not be remembered as one.
        cache.delete(k)
        throw e
      })
    cache.set(k, inflight)
  }
  return inflight
}

export interface ExpressionCheck {
  /** null while nothing has been checked — not the same as "clean". */
  result: ExpressionValidation | null
  checking: boolean
  /** True when the expression has an empty slot, so nothing was asked. */
  unfinished: boolean
}

export function useExpressionCheck(
  expression: string, store?: string, delayMs = 400,
): ExpressionCheck {
  const [result, setResult] = useState<ExpressionValidation | null>(null)
  const [checking, setChecking] = useState(false)

  const unfinished = !expression || hasHole(expression)

  useEffect(() => {
    if (unfinished) {
      setResult(null)
      setChecking(false)
      return
    }

    let cancelled = false
    setChecking(true)
    const t = setTimeout(() => {
      checkExpression(expression, store)
        .then((r) => { if (!cancelled) { setResult(r); setChecking(false) } })
        // A dropped request leaves the last verdict standing rather than
        // claiming the expression is clean.
        .catch(() => { if (!cancelled) setChecking(false) })
    }, delayMs)

    return () => { cancelled = true; clearTimeout(t) }
  }, [expression, store, unfinished, delayMs])

  return { result, checking, unfinished }
}
