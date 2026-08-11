import { useEffect, useState } from 'react'

// Mobile = below Tailwind's `lg` breakpoint (1024px). This matches the desktop
// cutoff used throughout the layout (the chat sidecar is `hidden lg:flex`), so
// `useIsMobile()` and `lg:` utilities always agree on what "desktop" means.
const MOBILE_QUERY = '(max-width: 1023px)'

function getMatches(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia(MOBILE_QUERY).matches
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(getMatches)

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    // Sync once in case the viewport changed between initial render and mount.
    setIsMobile(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isMobile
}
