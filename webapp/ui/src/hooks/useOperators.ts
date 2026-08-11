/**
 * The operator vocabulary, served when the API is up and built in when it isn't.
 *
 * The built-in registry in `registry.ts` was hand-written, and hand-written
 * copies of someone else's data drift. It had drifted three ways: no `And`/`Or`/
 * `Not` at all (so the parser recommended `And(...)` and then refused it),
 * `Kurt`'s minimum window transcribed from qlib's error message rather than the
 * guard it raises from, and one shared set of rolling semantics applied to `Ref`
 * and `Corr`, which do not share them.
 *
 * Serving it fixes those by construction. Keeping the fallback matters as much:
 * the canvas must still draw with the API down or the store unbuilt, and an
 * empty palette would be a worse answer than a slightly stale one.
 */
import { useEffect, useState } from 'react'

import { api } from '@/lib/api'
import { mergeRegistry } from '@/lib/factorExpr/registry'
import type { OperatorRegistry, OperatorSpec } from '@/lib/factorExpr/types'

export interface RefusedOperator {
  name: string
  summary: string
  reason: string
}

/**
 * Keep only entries the canvas can actually draw.
 *
 * `mergeRegistry` replaces a whole entry rather than merging field by field, so
 * a malformed one does not fall back to the built-in version — it installs an
 * operator with no slots, which renders as a card with nothing in it and no
 * error anywhere. Dropping it is the recoverable failure.
 */
function usable(value: unknown): value is OperatorSpec {
  const spec = value as Partial<OperatorSpec> | null
  return Boolean(
    spec && typeof spec.name === 'string' && typeof spec.category === 'string'
    && typeof spec.summary === 'string' && Array.isArray(spec.slots)
    && spec.slots.every((s) => s && typeof s.name === 'string'
                          && ['series', 'window', 'scalar'].includes(s.kind)),
  )
}

export function useOperators() {
  const [registry, setRegistry] = useState<OperatorRegistry>(() => mergeRegistry(null))
  const [refused, setRefused] = useState<RefusedOperator[]>([])
  const [served, setServed] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.operators()
      .then((response) => {
        if (cancelled) return
        const clean: OperatorRegistry = {}
        for (const [name, spec] of Object.entries(response.operators)) {
          if (usable(spec)) clean[name] = spec
        }
        setRegistry(mergeRegistry(clean))
        setRefused(response.refused ?? [])
        setServed(true)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  return { registry, refused, served }
}
