/**
 * The two-click "sure?" confirm for destructive controls.
 *
 * A misclick on a trash icon should not destroy work, and a dialog is too
 * heavy for a dense row. The first click arms, the second fires; the armed
 * state disarms itself after four seconds, and callers wire `disarm` to
 * `onMouseLeave` so moving away cancels too.
 *
 * This lived as two identical inline copies (the saved-strategy rail and the
 * run ledger) before feature-column delete needed a third.
 */
import { useCallback, useEffect, useState } from 'react'

export function useConfirmClick(timeoutMs = 4000) {
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!confirming) return
    const t = setTimeout(() => setConfirming(false), timeoutMs)
    return () => clearTimeout(t)
  }, [confirming, timeoutMs])

  const fire = useCallback((action: () => void) => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    action()
  }, [confirming])

  const disarm = useCallback(() => setConfirming(false), [])

  return { confirming, fire, disarm }
}
